package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"shelf/internal/api/response"
	"shelf/internal/vault"

	"github.com/coder/websocket"
	"go.uber.org/zap"
)

// awarenessInterval is the floor between two caret frames from one connection.
const awarenessInterval = 50 * time.Millisecond

// conn is one socket: one tab, one user, one writer goroutine.
//
// Every frame leaves through out, because the library allows a single concurrent writer
// and the ping shares the socket with the relayed frames.
type conn struct {
	ws  *websocket.Conn
	hub *Hub
	log *zap.Logger

	userID int64
	login  string
	name   string

	// vaults is what this socket follows, open is which notes it has joined. Both are read
	// and written under the hub's lock, which is the only thing that touches them.
	vaults map[int64]struct{}
	open   map[int64]struct{}

	// updates throttles document writes. Typing produces about four frames a second, so
	// this is what a stuck loop meets rather than what a fast typist meets.
	updates Limiter

	// expiry is the moment the access token stops authorising writes. It is replaced by a
	// later auth frame on the same socket rather than by a new connection.
	mu            sync.Mutex
	expiry        time.Time
	lastAwareness time.Time

	out    chan outbound
	cancel context.CancelFunc
}

// send queues a frame. A client that cannot keep up is closed rather than buffered: the
// queue is the only thing standing between a stalled reader and the process's memory.
func (c *conn) send(frame outbound) {
	select {
	case c.out <- frame:
	default:
		c.log.Warn("realtime send queue overflow, closing", zap.Int64("user_id", c.userID))
		c.cancel()
	}
}

// awarenessDue throttles caret traffic. A pointer moves continuously and the frames carry
// no history, so dropping the ones in between costs nothing and keeps a room of five from
// producing twenty relays for every twitch.
func (c *conn) awarenessDue() bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	if now.Sub(c.lastAwareness) < awarenessInterval {
		return false
	}

	c.lastAwareness = now

	return true
}

func (c *conn) inRoom(fileID int64) bool {
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()

	_, ok := c.open[fileID]

	return ok
}

// authorised reports whether the token backing this socket still permits writing.
func (c *conn) authorised(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	return now.Before(c.expiry)
}

// reauthorise moves the expiry of an already authenticated socket. The user is fixed at
// the handshake: a token for somebody else is a new session, not a renewal of this one.
func (c *conn) reauthorise(userID int64, expiry time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	if userID != c.userID {
		return false
	}

	c.expiry = expiry

	return true
}

// write drains the outbound queue and keeps the socket alive. It owns the socket for
// writing; nothing else may write to it.
func (c *conn) write(ctx context.Context, pingInterval time.Duration) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case frame := <-c.out:
			payload, err := json.Marshal(frame)
			if err != nil {
				c.log.Error("marshal realtime frame", zap.Error(err), zap.String("frame", frame.Type))
				continue
			}

			if err := c.ws.Write(ctx, websocket.MessageText, payload); err != nil {
				return
			}

		case <-ticker.C:
			// An idle socket is dropped by proxies and by some networks without either end
			// noticing; the ping is what turns that into a read error we can act on.
			if err := c.ws.Ping(ctx); err != nil {
				return
			}
		}
	}
}

// read consumes frames until the socket closes, the token's grace runs out or the context
// is cancelled.
func (c *conn) read(ctx context.Context, s Session, grace time.Duration) {
	for {
		_, payload, err := c.ws.Read(ctx)
		if err != nil {
			if !errClosed(err) {
				c.log.Debug("realtime read ended", zap.Error(err), zap.Int64("user_id", c.userID))
			}

			return
		}

		var frame inbound
		if err := json.Unmarshal(payload, &frame); err != nil {
			c.send(failure(response.CodeBadRequest, "frame is not valid JSON"))
			continue
		}

		now := time.Now()

		// Reading survives an expired token for a grace period, writing does not. A socket
		// trusted forever would make the short access TTL meaningless.
		if !c.authorised(now) && now.After(c.deadline(grace)) {
			_ = c.ws.Close(CloseUnauthorized, "token expired")
			return
		}

		c.dispatch(ctx, frame, s)
	}
}

// deadline is when an unrenewed socket stops being read at all.
func (c *conn) deadline(grace time.Duration) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.expiry.Add(grace)
}

func (c *conn) dispatch(ctx context.Context, frame inbound, s Session) {
	switch frame.Type {
	case FrameAuth:
		claims, err := s.Tokens.ParseAccess(frame.Token)
		if err != nil {
			c.send(failure(response.CodeUnauthorized, "invalid or expired access token"))
			return
		}

		userID, err := claims.UserID()
		if err != nil || claims.ExpiresAt == nil || !c.reauthorise(userID, claims.ExpiresAt.Time) {
			_ = c.ws.Close(CloseUnauthorized, "token does not belong to this session")
			return
		}

		c.send(ready(c.userID))

	case FrameSubscribe:
		c.subscribe(ctx, frame.VaultID, s)

	case FrameOpen:
		c.openNote(ctx, frame, s)

	case FrameSeed:
		c.seedNote(ctx, frame, s)

	case FrameUpdate:
		c.writeUpdate(ctx, frame, s)

	case FrameAwareness:
		c.relayAwareness(frame)

	case FrameClose:
		c.closeNote(frame.FileID)

	default:
		c.send(failure(response.CodeBadRequest, "unknown frame type"))
	}
}

// openNote joins the room for a note and hands back whatever document is there.
//
// View is enough: somebody with read access has to watch the edits arrive, and has to be
// able to show their own caret, or "who is here" is a lie. What they may not do is write,
// which is checked where writing happens.
func (c *conn) openNote(ctx context.Context, frame inbound, s Session) {
	ref, ok := c.resolve(ctx, frame.FileID, vault.PermView, s)
	if !ok {
		return
	}

	doc, err := s.Workspace.LiveDoc(ctx, c.userID, frame.FileID)

	switch {
	case errors.Is(err, vault.ErrNotFound):
		// No document yet. Whoever can write may seed one; a reader waits for them to.
		c.join(frame.FileID, ref)
		c.send(absent(frame.FileID, vault.FirstEpoch))

		return

	case err != nil:
		c.fail(frame.FileID, "read live document", err)

		return
	}

	// A document a body was written around keeps its row — the epoch has to go on rising —
	// but describes nothing: no snapshot, no log. Handing that over is what turns a write
	// from outside the session into a lost note, because the room adopts the empty text and
	// the committer writes it back over the body that replaced it. It is a document nobody
	// has started, and the answer to that is the one below.
	if doc.Snapshot == nil {
		c.join(frame.FileID, ref)
		c.send(absent(frame.FileID, doc.Epoch))

		return
	}

	// A client that reconnects holds everything up to its own sequence; one that is opening
	// the note holds nothing and gets the snapshot with the whole tail after it.
	since := frame.Since
	if frame.Epoch != doc.Epoch || since < doc.SnapshotSeq {
		since = doc.SnapshotSeq
	}

	tail, err := s.Workspace.LiveUpdates(ctx, c.userID, frame.FileID, doc.Epoch, since)
	if err != nil {
		c.fail(frame.FileID, "read live updates", err)
		return
	}

	c.join(frame.FileID, ref)
	c.send(document(doc, tail))
}

// seedNote starts a document for a note that has none.
//
// The loser of the race is handed the winner's document rather than an error: it has to
// throw its own away, because two independently seeded copies name the same characters
// differently and merging them writes the text twice.
func (c *conn) seedNote(ctx context.Context, frame inbound, s Session) {
	ref, ok := c.resolve(ctx, frame.FileID, vault.PermEdit, s)
	if !ok {
		return
	}

	if !c.writable(frame.FileID) {
		return
	}

	doc, _, err := s.Workspace.SeedLiveDoc(ctx, c.userID, vault.NewCRDTDoc{
		FileID:     frame.FileID,
		Epoch:      frame.Epoch,
		Snapshot:   vault.Blob{Ciphertext: frame.Payload, Nonce: frame.Nonce},
		KeyScopeID: frame.KeyScopeID,
		KeyVersion: frame.KeyVersion,
		ContentSeq: frame.ContentSeq,
		Signature:  frame.Signature,
	})
	if err != nil {
		c.fail(frame.FileID, "seed live document", err)
		return
	}

	tail, err := s.Workspace.LiveUpdates(ctx, c.userID, frame.FileID, doc.Epoch, doc.SnapshotSeq)
	if err != nil {
		c.fail(frame.FileID, "read live updates", err)
		return
	}

	c.join(frame.FileID, ref)
	c.send(document(doc, tail))
}

// writeUpdate stores one batch and relays it to the rest of the room.
func (c *conn) writeUpdate(ctx context.Context, frame inbound, s Session) {
	if _, ok := c.resolve(ctx, frame.FileID, vault.PermEdit, s); !ok {
		return
	}

	if !c.writable(frame.FileID) {
		return
	}

	if allowed, _ := c.updates.Allow(""); !allowed {
		c.send(failureFor(frame.FileID, response.CodeTooManyReqs, "too many updates"))
		return
	}

	stored, err := s.Workspace.AppendLiveUpdate(ctx, c.userID, vault.NewCRDTUpdate{
		FileID:     frame.FileID,
		Epoch:      frame.Epoch,
		Payload:    vault.Blob{Ciphertext: frame.Payload, Nonce: frame.Nonce},
		KeyScopeID: frame.KeyScopeID,
		KeyVersion: frame.KeyVersion,
		Signature:  frame.Signature,
	})
	if err != nil {
		c.fail(frame.FileID, "append live update", err)
		return
	}

	relay := relayed(frame.FileID, frame.Epoch, stored)

	if r := c.hub.lookupRoom(frame.FileID); r != nil {
		for _, other := range r.audience(c) {
			other.send(relay)
		}
	}

	c.send(acknowledged(frame.FileID, frame.Epoch, stored.Seq))
}

// relayAwareness passes on somebody's carets.
//
// It is not stored, not signed and not checked beyond the room they are in: awareness is
// rewritten several times a second and asserts nothing about the past. What it cannot do
// is claim to be somebody else — the user id on the relayed frame is the server's own, not
// whatever is inside the sealed payload.
func (c *conn) relayAwareness(frame inbound) {
	r := c.hub.lookupRoom(frame.FileID)
	if r == nil || !c.inRoom(frame.FileID) {
		return
	}

	if !c.awarenessDue() {
		return
	}

	out := awareness(frame.FileID, c.userID, frame.Payload, frame.Nonce)

	for _, other := range r.audience(c) {
		other.send(out)
	}
}

func (c *conn) closeNote(fileID int64) {
	r := c.hub.lookupRoom(fileID)

	c.hub.forget(c, fileID)

	if r == nil {
		return
	}

	if r.leave(c) {
		c.hub.dropRoom(fileID)
		return
	}

	r.announcePresence()
}

// resolve checks what the caller may do with a note, the same way the REST handlers do.
// A note they cannot see answers not_found rather than forbidden: otherwise an id becomes
// an oracle for what exists.
func (c *conn) resolve(ctx context.Context, fileID int64, least vault.Permission, s Session) (*vault.Ref, bool) {
	if fileID <= 0 {
		c.send(failure(response.CodeBadRequest, "file_id is required"))
		return nil, false
	}

	ref, err := s.Workspace.Ref(ctx, c.userID, fileID, least)
	if err != nil {
		c.fail(fileID, "resolve note", err)
		return nil, false
	}

	return ref, true
}

// writable refuses a write from a connection that has not opened the note. Joining is what
// puts somebody in the room, and a writer outside the room would produce an update nobody
// present ever hears about.
func (c *conn) writable(fileID int64) bool {
	if c.inRoom(fileID) {
		return true
	}

	c.send(failureFor(fileID, response.CodeBadRequest, "open the note before writing to it"))

	return false
}

func (c *conn) join(fileID int64, ref *vault.Ref) {
	r := c.hub.room(fileID)
	if r == nil {
		return
	}

	c.hub.remember(c, fileID)
	r.join(c, ref.Permission, c.login, c.name)
	r.announcePresence()
}

// fail turns a domain error into the frame the client acts on.
func (c *conn) fail(fileID int64, op string, err error) {
	switch {
	case errors.Is(err, vault.ErrNotFound), errors.Is(err, vault.ErrForbidden):
		// Forbidden reaches here only for a note the caller can already see; anything else
		// is not found, which is the same rule the REST layer follows.
		code := response.CodeNotFound
		if errors.Is(err, vault.ErrForbidden) {
			code = response.CodeForbidden
		}

		c.send(failureFor(fileID, code, "not available"))

	case errors.Is(err, vault.ErrEpochMismatch):
		// Not an error the client can retry: what it holds belongs to a document that has
		// been replaced, so it has to start again from what is there now.
		c.send(reseed(fileID, 0))

	case errors.Is(err, vault.ErrVersionConflict):
		c.send(failureFor(fileID, response.CodeConflict, "the note was changed by someone else"))

	case errors.Is(err, vault.ErrCompactRequired):
		c.send(failureFor(fileID, CodeCompactRequired, "the session needs to be committed"))

	case errors.Is(err, vault.ErrUpdateTooLarge):
		c.send(failureFor(fileID, response.CodeTooLarge, "that update is too large"))

	case errors.Is(err, vault.ErrScopeMismatch):
		c.send(failureFor(fileID, response.CodeConflict, "sealed under a different key"))

	case errors.Is(err, vault.ErrSignatureInvalid):
		c.send(failureFor(fileID, response.CodeValidation, "an author signature must be 64 raw bytes"))

	default:
		c.log.Error("realtime frame failed",
			zap.String("op", op), zap.Error(err), zap.Int64("user_id", c.userID))
		c.send(failureFor(fileID, response.CodeInternal, "internal server error"))
	}
}

// subscribe starts following a vault, if the caller is a member of it.
//
// A vault the caller cannot see answers not_found rather than forbidden, the same way the
// REST layer does: otherwise an id becomes an oracle for what exists.
func (c *conn) subscribe(ctx context.Context, vaultID int64, s Session) {
	if vaultID <= 0 {
		c.send(failure(response.CodeBadRequest, "vault_id is required"))
		return
	}

	if _, err := s.Workspace.Member(ctx, c.userID, vaultID); err != nil {
		c.send(failure(response.CodeNotFound, "vault not found"))
		return
	}

	c.hub.subscribe(c, vaultID)
	c.send(subscribed(vaultID))
}

// errClosed reports whether an error is the ordinary end of a socket rather than a fault
// worth logging.
func errClosed(err error) bool {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	status := websocket.CloseStatus(err)

	return status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}
