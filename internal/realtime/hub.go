package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/ratelimit"
	"shelf/internal/vault"

	"github.com/coder/websocket"
	"go.uber.org/zap"
)

// coalesceWindow is how long announcements for one vault are gathered before a frame goes
// out. A move that renames twenty notes should wake a reader once, not twenty times.
const coalesceWindow = 150 * time.Millisecond

// TokenParser validates an access token. Implemented by auth.Service.
type TokenParser interface {
	ParseAccess(token string) (*auth.Claims, error)
}

// Workspace is what the relay asks about permissions and live documents. Implemented by
// vault.Service, and deliberately so: a second implementation of the access model is a
// second place for it to drift from the one the REST handlers use.
type Workspace interface {
	Member(ctx context.Context, userID, vaultID int64) (*vault.Membership, error)
	Ref(ctx context.Context, userID, fileID int64, least vault.Permission) (*vault.Ref, error)
	LiveDoc(ctx context.Context, userID, fileID int64) (*vault.CRDTDoc, error)
	LiveUpdates(ctx context.Context, userID, fileID int64, epoch int32, since int64) ([]vault.CRDTUpdate, error)
	SeedLiveDoc(ctx context.Context, userID int64, in vault.NewCRDTDoc) (*vault.CRDTDoc, bool, error)
	AppendLiveUpdate(ctx context.Context, userID int64, in vault.NewCRDTUpdate) (*vault.CRDTUpdate, error)
}

// Directory names the person behind a connection for the presence list. The server already
// holds display names, so publishing them to the room teaches it nothing new.
type Directory interface {
	User(ctx context.Context, userID int64) (*auth.User, error)
}

// Session is what serving one connection needs beyond the socket itself. It arrives with
// the connection rather than with the hub, because the services it names are built from
// the repositories the hub is already wired into.
type Session struct {
	Tokens    TokenParser
	Workspace Workspace
	Users     Directory
}

// Hub owns the live connections and routes announcements to them.
//
// One process, one hub: the registry is a map rather than a broker, because a second
// instance is a deployment this build does not claim to support. Postgres LISTEN/NOTIFY is
// where that would go, and it would replace this type without touching its callers.
type Hub struct {
	cfg config.Realtime
	log *zap.Logger

	mu      sync.Mutex
	conns   map[*conn]struct{}
	perUser map[int64]int
	subs    map[int64]map[*conn]struct{}
	rooms   map[int64]*room
	pending map[int64]int64
	flush   *time.Timer
	closed  bool
}

// NewHub builds the registry. It holds no connections until one is served.
func NewHub(cfg config.Realtime, log *zap.Logger) *Hub {
	return &Hub{
		cfg:     cfg,
		log:     log,
		conns:   make(map[*conn]struct{}),
		perUser: make(map[int64]int),
		subs:    make(map[int64]map[*conn]struct{}),
		rooms:   make(map[int64]*room),
	}
}

// VaultChanged tells every follower of a vault that it has moved. It is called after the
// transaction committed, so a client pulling on this hint reads what was written.
//
// The frame carries a sequence, not the change: the client already has a delta endpoint
// that knows how to apply one, and a second path for the same job is a second path to keep
// in agreement with the first.
func (h *Hub) VaultChanged(vaultID, changeSeq int64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.closed {
		return
	}

	if h.pending == nil {
		h.pending = make(map[int64]int64, 1)
	}

	if changeSeq > h.pending[vaultID] {
		h.pending[vaultID] = changeSeq
	}

	if h.flush == nil {
		h.flush = time.AfterFunc(coalesceWindow, h.announce)
	}
}

// announce sends one frame per vault that moved during the window.
func (h *Hub) announce() {
	h.mu.Lock()

	moved := h.pending
	h.pending = nil
	h.flush = nil

	type delivery struct {
		conn  *conn
		frame outbound
	}

	deliveries := make([]delivery, 0, len(moved))

	for vaultID, seq := range moved {
		for c := range h.subs[vaultID] {
			deliveries = append(deliveries, delivery{conn: c, frame: changed(vaultID, seq)})
		}
	}

	h.mu.Unlock()

	// Outside the lock: send closes a stalled connection, which takes the lock again.
	for _, d := range deliveries {
		d.conn.send(d.frame)
	}
}

// Close ends every live session.
//
// http.Server.Shutdown neither closes hijacked connections nor waits for them, so without
// this the clients would see a severed TCP connection instead of a close frame, and the
// process could sit on its sockets until the timeout.
func (h *Hub) Close() {
	h.mu.Lock()

	if h.closed {
		h.mu.Unlock()
		return
	}

	h.closed = true

	if h.flush != nil {
		h.flush.Stop()
		h.flush = nil
	}

	live := make([]*conn, 0, len(h.conns))
	for c := range h.conns {
		live = append(live, c)
	}

	h.mu.Unlock()

	for _, c := range live {
		_ = c.ws.Close(websocket.StatusGoingAway, "server is shutting down")
		c.cancel()
	}
}

// Serve runs one connection until it closes. It blocks, which is what keeps the request
// context alive for a socket the HTTP layer has already handed over.
func (h *Hub) Serve(ctx context.Context, ws *websocket.Conn, s Session) {
	ws.SetReadLimit(h.cfg.MaxFrameBytes)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	c := &conn{
		ws:      ws,
		hub:     h,
		log:     h.log,
		out:     make(chan outbound, h.cfg.SendQueue),
		cancel:  cancel,
		vaults:  make(map[int64]struct{}),
		open:    make(map[int64]struct{}),
		updates: updateLimiter(h.cfg.UpdateRate),
	}

	who, err := h.handshake(ctx, c, s.Tokens)
	if err != nil {
		_ = ws.Close(CloseUnauthorized, err.Error())
		return
	}

	c.userID = who.userID
	c.expiry = who.expiry

	// Read once, at the handshake: the presence list needs a name for every frame that
	// changes a roster, and asking the database each time would put a query on the path of
	// somebody opening a note.
	if user, err := s.Users.User(ctx, c.userID); err == nil {
		c.login, c.name = user.Login, user.DisplayName
	}

	if err := h.add(c); err != nil {
		_ = ws.Close(websocket.StatusTryAgainLater, err.Error())
		return
	}

	defer h.remove(c)

	go c.write(ctx, h.cfg.PingInterval)

	c.send(ready(c.userID))
	c.read(ctx, s, h.cfg.ReauthGrace)

	_ = ws.Close(websocket.StatusNormalClosure, "")
}

// identity is what the handshake establishes about the socket.
type identity struct {
	userID int64
	expiry time.Time
}

// handshake reads the one frame a connection must send before anything else.
//
// The token travels in the frame rather than in the URL: a query string lands in every
// access log on the way, which is the same reason the request logger redacts it.
func (h *Hub) handshake(ctx context.Context, c *conn, tokens TokenParser) (identity, error) {
	// A timer rather than a context deadline: cancelling the context mid-Read leaves the
	// socket unusable for a close frame, and a client that is refused deserves a reason
	// rather than a severed connection. Close is safe to call from here.
	timer := time.AfterFunc(h.cfg.AuthDeadline, func() {
		_ = c.ws.Close(CloseUnauthorized, "no auth frame")
	})
	defer timer.Stop()

	_, payload, err := c.ws.Read(ctx)
	if err != nil {
		return identity{}, errors.New("no auth frame")
	}

	var frame inbound
	if err := json.Unmarshal(payload, &frame); err != nil || frame.Type != FrameAuth {
		return identity{}, errors.New("first frame must be auth")
	}

	claims, err := tokens.ParseAccess(frame.Token)
	if err != nil {
		return identity{}, errors.New("invalid or expired access token")
	}

	userID, err := claims.UserID()
	if err != nil || claims.ExpiresAt == nil {
		return identity{}, errors.New("invalid or expired access token")
	}

	return identity{userID: userID, expiry: claims.ExpiresAt.Time}, nil
}

// add registers a connection unless the hub is closing or the account already holds as
// many as it may. Without the cap one account can occupy every goroutine the hub has.
func (h *Hub) add(c *conn) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.closed {
		return errors.New("server is shutting down")
	}

	if h.perUser[c.userID] >= h.cfg.MaxConnsPerUser {
		return errors.New("too many connections")
	}

	h.conns[c] = struct{}{}
	h.perUser[c.userID]++

	return nil
}

func (h *Hub) remove(c *conn) {
	rooms := h.deregister(c)

	// Outside the hub's lock: leaving a room takes the room's own, and announcing writes to
	// sockets. A closed tab has to stop showing a caret, so the room is told either way.
	for _, r := range rooms {
		if r.leave(c) {
			h.dropRoom(r.fileID)
			continue
		}

		r.announcePresence()
	}
}

// deregister takes the connection out of the registry and hands back the rooms it was in.
func (h *Hub) deregister(c *conn) []*room {
	h.mu.Lock()
	defer h.mu.Unlock()

	if _, ok := h.conns[c]; !ok {
		return nil
	}

	delete(h.conns, c)

	if h.perUser[c.userID]--; h.perUser[c.userID] <= 0 {
		delete(h.perUser, c.userID)
	}

	for vaultID := range c.vaults {
		h.unsubscribeLocked(c, vaultID)
	}

	rooms := make([]*room, 0, len(c.open))

	for fileID := range c.open {
		if existing, ok := h.rooms[fileID]; ok {
			rooms = append(rooms, existing)
		}
	}

	return rooms
}

func (h *Hub) subscribe(c *conn, vaultID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.subs[vaultID] == nil {
		h.subs[vaultID] = make(map[*conn]struct{}, 1)
	}

	h.subs[vaultID][c] = struct{}{}
	c.vaults[vaultID] = struct{}{}
}

func (h *Hub) unsubscribeLocked(c *conn, vaultID int64) {
	followers := h.subs[vaultID]
	if followers == nil {
		return
	}

	delete(followers, c)

	if len(followers) == 0 {
		delete(h.subs, vaultID)
	}
}

// remember and forget track which notes a socket has joined, so a dropped connection can
// be taken out of every room it was in.
func (h *Hub) remember(c *conn, fileID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	c.open[fileID] = struct{}{}
}

func (h *Hub) forget(c *conn, fileID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	delete(c.open, fileID)
}

// NoteInvalidated tells everyone editing a note that the document they hold has been
// replaced — by a body written around it, or by a re-key that re-encrypted it under a key
// their updates were not written against.
//
// Like VaultChanged, it is called after the transaction committed. Unlike it, there is
// nothing to coalesce: invalidation is rare and each one has to be acted on.
func (h *Hub) NoteInvalidated(fileID int64) {
	r := h.lookupRoom(fileID)
	if r == nil {
		return
	}

	frame := reseed(fileID, 0)

	for _, c := range r.everyone() {
		c.send(frame)
	}
}

// Limiter throttles one connection's writes. Implemented by ratelimit.Limiter.
type Limiter interface {
	Allow(key string) (bool, time.Duration)
}

// updateLimiter builds the per-connection throttle, or a no-op when the rule is unset —
// the same shape the HTTP rate limits use when they are turned off.
func updateLimiter(rule config.Rule) Limiter {
	if rule.Limit <= 0 || rule.Window <= 0 {
		return ratelimit.Nop{}
	}

	return ratelimit.New(rule.Limit, rule.Window)
}

// Connections reports how many sockets are live.
func (h *Hub) Connections() int {
	h.mu.Lock()
	defer h.mu.Unlock()

	return len(h.conns)
}
