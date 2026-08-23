package mcp

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	domain "shelf/internal/mcp"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const testSecret = "shelf_mcp_test_credential"

type stubConnector struct {
	err error
}

func (s *stubConnector) Authenticate(context.Context, string) (*domain.Connector, error) {
	if s.err != nil {
		return nil, s.err
	}

	return &domain.Connector{VaultID: 1, UserID: 2, Login: "connector"}, nil
}

func (s *stubConnector) Workspace(context.Context, *domain.Connector) (*domain.Workspace, error) {
	return nil, errors.New("not used here")
}

// streaming serves a response that outlives the write timeout, the way a connector session
// held open for a model to work through does.
func streaming(pause time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Status(http.StatusOK)
		c.Writer.Flush()

		time.Sleep(pause)

		_, _ = c.Writer.WriteString("done")
	}
}

// The router exempts this path from the handler deadline, but http.Server.WriteTimeout is a
// deadline on the socket set before the handler runs, and no middleware reaches it. Without
// the reset in authenticate the stream is cut at the TCP level partway through, which is what
// a Claude session that stops mid-answer for no logged reason looks like.
func TestAuthenticatedStreamOutlivesTheWriteTimeout(t *testing.T) {
	gin.SetMode(gin.TestMode)

	const writeTimeout = 150 * time.Millisecond

	transport := NewTransport(&stubConnector{}, "https://shelf.test", zap.NewNop())

	engine := gin.New()
	engine.GET(Path, transport.authenticate, streaming(4*writeTimeout))

	srv := httptest.NewUnstartedServer(engine)
	srv.Config.WriteTimeout = writeTimeout
	srv.Start()

	defer srv.Close()

	req, err := http.NewRequest(http.MethodGet, srv.URL+Path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}

	req.Header.Set("Authorization", "Bearer "+testSecret)

	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}

	defer func() { _ = resp.Body.Close() }()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("the stream was cut before it finished: %v", err)
	}

	if string(body) != "done" {
		t.Fatalf("body = %q, want %q", body, "done")
	}
}

func TestUnauthenticatedCallIsChallenged(t *testing.T) {
	gin.SetMode(gin.TestMode)

	transport := NewTransport(&stubConnector{}, "https://shelf.test/", zap.NewNop())

	engine := gin.New()
	engine.GET(Path, transport.authenticate, streaming(0))

	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, Path, nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	const want = `Bearer resource_metadata="https://shelf.test/.well-known/oauth-protected-resource"`
	if got := rec.Header().Get("WWW-Authenticate"); got != want {
		t.Fatalf("WWW-Authenticate = %q, want %q", got, want)
	}
}
