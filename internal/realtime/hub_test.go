package realtime_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
	"time"

	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/realtime"
	"shelf/internal/vault"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

// tokens answers with whatever the test put in it, so the hub is exercised without an
// auth service, a database or a real signature.
type tokens struct {
	claims map[string]*auth.Claims
}

func (t tokens) ParseAccess(token string) (*auth.Claims, error) {
	claims, ok := t.claims[token]
	if !ok {
		return nil, auth.ErrInvalidToken
	}

	return claims, nil
}

// workspace stands in for the vault service: membership, note permissions and the live
// document, all in memory. What the hub is being held to here is that it asks at all, and
// that it does the right thing with the answers.
type workspace struct {
	mu sync.Mutex

	vaults map[int64]bool
	// perms is the permission each user has on each note, keyed by user then note. A note
	// missing from a user's map is one they cannot see.
	perms map[int64]map[int64]vault.Permission
	docs  map[int64]*vault.CRDTDoc
	log   map[int64][]vault.CRDTUpdate
}

func newWorkspace() *workspace {
	return &workspace{
		vaults: make(map[int64]bool),
		perms:  make(map[int64]map[int64]vault.Permission),
		docs:   make(map[int64]*vault.CRDTDoc),
		log:    make(map[int64][]vault.CRDTUpdate),
	}
}

func (w *workspace) allow(userID, fileID int64, permission vault.Permission) *workspace {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.perms[userID] == nil {
		w.perms[userID] = make(map[int64]vault.Permission)
	}

	w.perms[userID][fileID] = permission

	return w
}

func (w *workspace) Member(_ context.Context, _, vaultID int64) (*vault.Membership, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.vaults[vaultID] {
		return nil, vault.ErrNotFound
	}

	return &vault.Membership{Role: vault.RoleEditor}, nil
}

func (w *workspace) Ref(_ context.Context, userID, fileID int64, least vault.Permission) (*vault.Ref, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	permission, ok := w.perms[userID][fileID]
	if !ok {
		return nil, vault.ErrNotFound
	}

	if !permission.AtLeast(least) {
		return nil, vault.ErrForbidden
	}

	return &vault.Ref{ID: fileID, Permission: permission, KeyScopeID: 3, KeyVersion: 1}, nil
}

func (w *workspace) LiveDoc(_ context.Context, _, fileID int64) (*vault.CRDTDoc, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	doc, ok := w.docs[fileID]
	if !ok {
		return nil, vault.ErrNotFound
	}

	copied := *doc

	return &copied, nil
}

func (w *workspace) LiveUpdates(
	_ context.Context,
	_, fileID int64,
	epoch int32,
	since int64,
) ([]vault.CRDTUpdate, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	tail := make([]vault.CRDTUpdate, 0)

	for _, stored := range w.log[fileID] {
		if stored.Epoch == epoch && stored.Seq > since {
			tail = append(tail, stored)
		}
	}

	return tail, nil
}

func (w *workspace) SeedLiveDoc(
	_ context.Context,
	userID int64,
	in vault.NewCRDTDoc,
) (*vault.CRDTDoc, bool, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if existing, ok := w.docs[in.FileID]; ok {
		copied := *existing

		return &copied, false, nil
	}

	doc := &vault.CRDTDoc{
		FileID: in.FileID, KeyScopeID: in.KeyScopeID, KeyVersion: in.KeyVersion,
		Epoch: 1, CommittedSeq: in.ContentSeq, Snapshot: &in.Snapshot, CreatedBy: &userID,
	}
	w.docs[in.FileID] = doc

	copied := *doc

	return &copied, true, nil
}

func (w *workspace) AppendLiveUpdate(
	_ context.Context,
	userID int64,
	in vault.NewCRDTUpdate,
) (*vault.CRDTUpdate, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	doc, ok := w.docs[in.FileID]
	if !ok {
		return nil, vault.ErrNotFound
	}

	if doc.Epoch != in.Epoch {
		return nil, vault.ErrEpochMismatch
	}

	doc.LastSeq++
	stored := vault.CRDTUpdate{
		Seq: doc.LastSeq, Epoch: in.Epoch, Payload: in.Payload,
		AuthorID: &userID, Signature: in.Signature,
	}
	w.log[in.FileID] = append(w.log[in.FileID], stored)

	return &stored, nil
}

// directory names the people in a room.
type directory struct{}

func (directory) User(_ context.Context, userID int64) (*auth.User, error) {
	return &auth.User{
		ID:          userID,
		Login:       fmt.Sprintf("user%d@test.invalid", userID),
		DisplayName: fmt.Sprintf("User %d", userID),
	}, nil
}

func claimsFor(userID int64, ttl time.Duration) *auth.Claims {
	return &auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   strconv.FormatInt(userID, 10),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
		},
		Scope: "access",
	}
}

func testConfig() config.Realtime {
	return config.Realtime{
		Enabled:         true,
		AuthDeadline:    150 * time.Millisecond,
		ReauthGrace:     time.Minute,
		PingInterval:    time.Minute,
		MaxConnsPerUser: 2,
		MaxFrameBytes:   64 << 10,
		SendQueue:       16,
		UpdateRate:      config.Rule{Limit: 60, Window: 10 * time.Second},
	}
}

// serve starts a hub behind a real HTTP server, because the handshake is the thing under
// test and it only exists on a real socket.
func serve(t *testing.T, parser realtime.TokenParser, cfg config.Realtime, vaults ...int64) (*realtime.Hub, string) {
	t.Helper()

	ws := newWorkspace()
	for _, id := range vaults {
		ws.vaults[id] = true
	}

	hub, url := serveWith(t, parser, cfg, ws)

	return hub, url
}

// serveWith is the same, with a workspace the caller has already arranged.
func serveWith(
	t *testing.T,
	parser realtime.TokenParser,
	cfg config.Realtime,
	ws *workspace,
) (*realtime.Hub, string) {
	t.Helper()

	hub := realtime.NewHub(cfg, zap.NewNop())
	session := realtime.Session{Tokens: parser, Workspace: ws, Users: directory{}}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}

		defer func() { _ = ws.CloseNow() }()

		hub.Serve(r.Context(), ws, session)
	}))

	t.Cleanup(func() {
		hub.Close()
		server.Close()
	})

	return hub, "ws" + server.URL[len("http"):]
}

func dial(t *testing.T, url string) *websocket.Conn {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	t.Cleanup(func() { _ = ws.CloseNow() })

	return ws
}

func write(t *testing.T, ws *websocket.Conn, frame map[string]any) {
	t.Helper()

	payload, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal frame: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	if err := ws.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("write frame: %v", err)
	}
}

func read(t *testing.T, ws *websocket.Conn) map[string]any {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, payload, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}

	var frame map[string]any
	if err := json.Unmarshal(payload, &frame); err != nil {
		t.Fatalf("decode frame: %v", err)
	}

	return frame
}

// closeStatus waits for the socket to end and reports how.
func closeStatus(t *testing.T, ws *websocket.Conn) websocket.StatusCode {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	for {
		_, _, err := ws.Read(ctx)
		if err == nil {
			continue
		}

		return websocket.CloseStatus(err)
	}
}

func TestAuthenticatedConnectionBecomesReady(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	_, url := serve(t, parser, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})

	frame := read(t, ws)
	if frame["type"] != realtime.FrameReady {
		t.Fatalf("first frame is %v, want ready", frame["type"])
	}

	if frame["user_id"] != float64(7) {
		t.Fatalf("ready names user %v, want 7", frame["user_id"])
	}
}

// A socket that never says who it is holds a goroutine for as long as it stays quiet.
func TestSilentConnectionIsClosed(t *testing.T) {
	t.Parallel()

	_, url := serve(t, tokens{}, testConfig())

	ws := dial(t, url)

	if status := closeStatus(t, ws); status != realtime.CloseUnauthorized {
		t.Fatalf("silent connection closed with %v, want %d", status, realtime.CloseUnauthorized)
	}
}

func TestBadTokenIsRefused(t *testing.T) {
	t.Parallel()

	_, url := serve(t, tokens{}, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "forged"})

	if status := closeStatus(t, ws); status != realtime.CloseUnauthorized {
		t.Fatalf("forged token closed with %v, want %d", status, realtime.CloseUnauthorized)
	}
}

// The token comes first or not at all: accepting anything else would let a connection do
// work before it has said who is doing it.
func TestFirstFrameMustBeAuth(t *testing.T) {
	t.Parallel()

	_, url := serve(t, tokens{}, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "subscribe", "vault_id": 1})

	if status := closeStatus(t, ws); status != realtime.CloseUnauthorized {
		t.Fatalf("unauthenticated frame closed with %v, want %d", status, realtime.CloseUnauthorized)
	}
}

// A live socket is renewed, not re-pointed: swapping the user on it would let one session
// inherit another's access without a new handshake.
func TestReauthWithAnotherUserClosesTheSocket(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{
		"mine":   claimsFor(7, time.Hour),
		"theirs": claimsFor(9, time.Hour),
	}}
	_, url := serve(t, parser, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "mine"})

	if frame := read(t, ws); frame["type"] != realtime.FrameReady {
		t.Fatalf("first frame is %v, want ready", frame["type"])
	}

	write(t, ws, map[string]any{"type": "auth", "token": "theirs"})

	if status := closeStatus(t, ws); status != realtime.CloseUnauthorized {
		t.Fatalf("foreign token closed with %v, want %d", status, realtime.CloseUnauthorized)
	}
}

// Renewing on the same socket is what keeps an editing session alive past the 15-minute
// access TTL without a reconnect.
func TestReauthWithTheSameUserIsAccepted(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{
		"first":  claimsFor(7, time.Hour),
		"second": claimsFor(7, 2*time.Hour),
	}}
	_, url := serve(t, parser, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "first"})
	read(t, ws)

	write(t, ws, map[string]any{"type": "auth", "token": "second"})

	if frame := read(t, ws); frame["type"] != realtime.FrameReady {
		t.Fatalf("renewal answered %v, want ready", frame["type"])
	}
}

func TestConnectionsPerUserAreCapped(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.MaxConnsPerUser = 1

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	hub, url := serve(t, parser, cfg)

	first := dial(t, url)
	write(t, first, map[string]any{"type": "auth", "token": "good"})
	read(t, first)

	second := dial(t, url)
	write(t, second, map[string]any{"type": "auth", "token": "good"})

	if status := closeStatus(t, second); status != websocket.StatusTryAgainLater {
		t.Fatalf("the second connection closed with %v, want TryAgainLater", status)
	}

	if got := hub.Connections(); got != 1 {
		t.Fatalf("hub holds %d connections, want 1", got)
	}
}

// Shutdown neither closes hijacked connections nor waits for them, so the hub has to.
func TestCloseEndsEverySession(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	hub, url := serve(t, parser, testConfig())

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})
	read(t, ws)

	hub.Close()

	if status := closeStatus(t, ws); status != websocket.StatusGoingAway {
		t.Fatalf("shutdown closed with %v, want GoingAway", status)
	}

	if got := hub.Connections(); got != 0 {
		t.Fatalf("hub still holds %d connections after close", got)
	}
}

// An expired token stops writes at once and reads after the grace period. Trusting the
// socket indefinitely would leave a revoked session a channel of its own.
func TestExpiredTokenClosesTheSocketAfterTheGrace(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.ReauthGrace = 0

	parser := tokens{claims: map[string]*auth.Claims{"brief": claimsFor(7, 40*time.Millisecond)}}
	_, url := serve(t, parser, cfg)

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "brief"})
	read(t, ws)

	time.Sleep(80 * time.Millisecond)
	write(t, ws, map[string]any{"type": "auth", "token": "brief"})

	if status := closeStatus(t, ws); status != realtime.CloseUnauthorized {
		t.Fatalf("expired session closed with %v, want %d", status, realtime.CloseUnauthorized)
	}
}

// A hint is what turns an eight-second poll into an instant one; it carries a sequence
// rather than the change, because the client already knows how to apply a delta.
func TestSubscriberHearsThatTheVaultMoved(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	hub, url := serve(t, parser, testConfig(), 12)

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})
	read(t, ws)

	write(t, ws, map[string]any{"type": "subscribe", "vault_id": 12})

	if frame := read(t, ws); frame["type"] != realtime.FrameSubscribed {
		t.Fatalf("subscribe answered %v, want subscribed", frame["type"])
	}

	hub.VaultChanged(12, 9438)

	frame := read(t, ws)
	if frame["type"] != realtime.FrameChanged {
		t.Fatalf("announcement is %v, want changed", frame["type"])
	}

	if frame["vault_id"] != float64(12) || frame["change_seq"] != float64(9438) {
		t.Fatalf("announcement carries %v/%v, want 12/9438", frame["vault_id"], frame["change_seq"])
	}
}

// A vault the caller cannot see answers not_found rather than forbidden: otherwise an id
// becomes an oracle for what exists.
func TestSubscribingToAForeignVaultIsRefused(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	_, url := serve(t, parser, testConfig(), 12)

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})
	read(t, ws)

	write(t, ws, map[string]any{"type": "subscribe", "vault_id": 99})

	frame := read(t, ws)
	if frame["type"] != realtime.FrameError {
		t.Fatalf("foreign vault answered %v, want error", frame["type"])
	}

	if frame["code"] != "not_found" {
		t.Fatalf("foreign vault answered %v, want not_found", frame["code"])
	}
}

// A move that renames twenty notes should wake a reader once, at the sequence it has to
// catch up to — not twenty times.
func TestAnnouncementsAreCoalesced(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	hub, url := serve(t, parser, testConfig(), 12)

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})
	read(t, ws)
	write(t, ws, map[string]any{"type": "subscribe", "vault_id": 12})
	read(t, ws)

	for seq := int64(100); seq < 120; seq++ {
		hub.VaultChanged(12, seq)
	}

	frame := read(t, ws)
	if frame["change_seq"] != float64(119) {
		t.Fatalf("coalesced announcement carries %v, want the highest sequence 119", frame["change_seq"])
	}

	// A second frame would mean the burst was not folded into one.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if _, _, err := ws.Read(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a burst of twenty writes produced more than one frame: %v", err)
	}
}

// Following one vault must not leak the movements of another.
func TestOtherVaultsAreNotAnnounced(t *testing.T) {
	t.Parallel()

	parser := tokens{claims: map[string]*auth.Claims{"good": claimsFor(7, time.Hour)}}
	hub, url := serve(t, parser, testConfig(), 12, 13)

	ws := dial(t, url)
	write(t, ws, map[string]any{"type": "auth", "token": "good"})
	read(t, ws)
	write(t, ws, map[string]any{"type": "subscribe", "vault_id": 12})
	read(t, ws)

	hub.VaultChanged(13, 500)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if _, _, err := ws.Read(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("a vault the socket does not follow was announced to it: %v", err)
	}
}

// The library refuses a cross-origin handshake by default, and CORS does not apply to an
// upgrade — so this check is the only one there is.
func TestForeignOriginIsRefused(t *testing.T) {
	t.Parallel()

	hub := realtime.NewHub(testConfig(), zap.NewNop())
	t.Cleanup(hub.Close)

	session := realtime.Session{Tokens: tokens{}, Workspace: newWorkspace(), Users: directory{}}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}

		defer func() { _ = ws.CloseNow() }()

		hub.Serve(r.Context(), ws, session)
	}))
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):], &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": []string{"http://evil.example"}},
	})
	if err == nil {
		t.Fatal("a cross-origin handshake was accepted")
	}

	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("handshake hung instead of being refused: %v", err)
	}
}
