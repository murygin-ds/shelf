package realtime_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	realtimeapi "shelf/internal/api/v1/realtime"
	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/realtime"
	"shelf/internal/vault"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

// noAccess stands in for the vault service: this test never opens anything, it only holds
// a socket long enough to prove it survives the server's write timeout.
type noAccess struct{}

func (noAccess) Member(context.Context, int64, int64) (*vault.Membership, error) {
	return nil, vault.ErrNotFound
}

func (noAccess) Ref(context.Context, int64, int64, vault.Permission) (*vault.Ref, error) {
	return nil, vault.ErrNotFound
}

func (noAccess) LiveDoc(context.Context, int64, int64) (*vault.CRDTDoc, error) {
	return nil, vault.ErrNotFound
}

func (noAccess) LiveUpdates(context.Context, int64, int64, int32, int64) ([]vault.CRDTUpdate, error) {
	return nil, vault.ErrNotFound
}

func (noAccess) SeedLiveDoc(context.Context, int64, vault.NewCRDTDoc) (*vault.CRDTDoc, bool, error) {
	return nil, false, vault.ErrNotFound
}

func (noAccess) AppendLiveUpdate(context.Context, int64, vault.NewCRDTUpdate) (*vault.CRDTUpdate, error) {
	return nil, vault.ErrNotFound
}

// noDirectory answers the one lookup the handshake makes.
type noDirectory struct{}

func (noDirectory) User(_ context.Context, userID int64) (*auth.User, error) {
	return &auth.User{ID: userID, Login: "someone@test.invalid", DisplayName: "Someone"}, nil
}

type tokens struct{ userID int64 }

func (t tokens) ParseAccess(token string) (*auth.Claims, error) {
	if token != "good" {
		return nil, auth.ErrInvalidToken
	}

	return &auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   strconv.FormatInt(t.userID, 10),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Scope: "access",
	}, nil
}

// The socket has to outlive the server's WriteTimeout.
//
// net/http clears the connection's deadlines while hijacking it, so this holds today
// without the handler doing anything. It is worth pinning down anyway: a session that
// silently dies after write_timeout would look like a network fault, and nothing else in
// the suite would notice. The timeouts here are milliseconds; the mechanism is the same as
// the 10s configured in production.
func TestSocketOutlivesTheServerWriteTimeout(t *testing.T) {
	t.Parallel()

	gin.SetMode(gin.TestMode)

	cfg := config.Realtime{
		Enabled:         true,
		AuthDeadline:    5 * time.Second,
		ReauthGrace:     time.Minute,
		PingInterval:    time.Minute,
		MaxConnsPerUser: 4,
		MaxFrameBytes:   64 << 10,
		SendQueue:       16,
		UpdateRate:      config.Rule{Limit: 60, Window: 10 * time.Second},
	}

	hub := realtime.NewHub(cfg, zap.NewNop())
	t.Cleanup(hub.Close)

	session := realtime.Session{Tokens: tokens{userID: 7}, Workspace: noAccess{}, Users: noDirectory{}}

	engine := gin.New()
	realtimeapi.NewHandler(hub, session, config.HTTP{}, zap.NewNop()).RegisterRoutes(&engine.RouterGroup)

	server := httptest.NewUnstartedServer(engine)
	server.Config.ReadTimeout = 200 * time.Millisecond
	server.Config.WriteTimeout = 200 * time.Millisecond
	server.Start()

	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	ws, _, err := websocket.Dial(ctx, "ws"+server.URL[len("http"):]+realtimeapi.Path, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	defer func() { _ = ws.CloseNow() }()

	// Twice the write timeout: a socket still carrying the server's deadlines is dead by now.
	time.Sleep(400 * time.Millisecond)

	payload, err := json.Marshal(map[string]any{"type": "auth", "token": "good"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	if err := ws.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("write after the write timeout: %v", err)
	}

	_, answer, err := ws.Read(ctx)
	if err != nil {
		t.Fatalf("read after the write timeout: %v", err)
	}

	var frame map[string]any
	if err := json.Unmarshal(answer, &frame); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if frame["type"] != realtime.FrameReady {
		t.Fatalf("answered %v, want ready", frame["type"])
	}
}
