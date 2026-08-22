package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"shelf/internal/api/middleware"
	handler "shelf/internal/api/v1/mcp"
	domain "shelf/internal/mcp"
	"shelf/internal/vault"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const testUserID int64 = 42

type stubService struct {
	err error

	connector   *domain.Connector
	issued      *domain.Issued
	credentials []domain.TokenSummary
	scopes      []int64

	lastRole vault.Role
	lastKeys []domain.SealedKey
}

func (s *stubService) Enable(_ context.Context, _, _ int64, role vault.Role) (*domain.Connector, error) {
	s.lastRole = role

	return s.connector, s.err
}

func (s *stubService) Admit(_ context.Context, _, _ int64, keys []domain.SealedKey) (*domain.Connector, error) {
	s.lastKeys = keys

	return s.connector, s.err
}

func (s *stubService) Disable(context.Context, int64, int64) ([]int64, error) {
	return s.scopes, s.err
}

func (s *stubService) Status(context.Context, int64, int64) (*domain.Connector, error) {
	return s.connector, s.err
}

func (s *stubService) IssueStatic(context.Context, int64, int64, string) (*domain.Issued, error) {
	return s.issued, s.err
}

func (s *stubService) Credentials(context.Context, int64, int64) ([]domain.TokenSummary, error) {
	return s.credentials, s.err
}

func (s *stubService) RevokeCredentials(context.Context, int64, int64) error { return s.err }

func newTestRouter(t *testing.T, service handler.Service) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	protected := router.Group("/api/v1", func(c *gin.Context) {
		c.Set(middleware.ContextUserID, testUserID)
		c.Next()
	})

	handler.NewHandler(service, zap.NewNop()).RegisterRoutes(protected)

	return router
}

func do(t *testing.T, router *gin.Engine, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()

	raw := []byte(nil)

	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		raw = encoded
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	return rec
}

func ready() *domain.Connector {
	return &domain.Connector{
		VaultID: 7, UserID: 99, Login: "connector.mcp.x",
		PublicKey: bytes.Repeat([]byte{1}, 131), Fingerprint: "NFX3 V6FY TMS2 M6S9",
		Role: vault.RoleEditor, KeyState: vault.KeyStateOK, CreatedAt: time.Now(),
	}
}

func TestEnableRejectsARoleThatManagesPeople(t *testing.T) {
	router := newTestRouter(t, &stubService{connector: ready()})

	// owner and admin decide who else gets in. A connector reads and writes notes.
	for _, role := range []string{"owner", "admin", "", "editor "} {
		rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp/identity", map[string]any{"role": role})

		if rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusBadRequest {
			t.Errorf("role %q was accepted with %d", role, rec.Code)
		}
	}

	service := &stubService{connector: ready()}
	router = newTestRouter(t, service)

	rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp/identity", map[string]any{"role": "viewer"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("viewer was refused with %d: %s", rec.Code, rec.Body)
	}

	if service.lastRole != vault.RoleViewer {
		t.Errorf("the handler passed role %q", service.lastRole)
	}
}

func TestAdmitValidatesTheSealedKeys(t *testing.T) {
	service := &stubService{connector: ready()}
	router := newTestRouter(t, service)

	key := func(over map[string]any) map[string]any {
		base := map[string]any{
			"scope_id":       11,
			"key_version":    2,
			"wrapped_key":    bytes.Repeat([]byte{1}, 98),
			"nonce":          bytes.Repeat([]byte{2}, 12),
			"wrap_algorithm": "ecdh-p256-hkdf-a256gcm",
		}

		for name, value := range over {
			base[name] = value
		}

		return base
	}

	// The server cannot look inside a sealed key, so the only thing it can refuse is a shape
	// that could not be one.
	for name, broken := range map[string]map[string]any{
		"a key too short to be a sealed box": {"wrapped_key": []byte{1}},
		"a nonce of the wrong length":        {"nonce": []byte{1, 2, 3}},
		"a scope that is not an id":          {"scope_id": 0},
		"a version below the first":          {"key_version": 0},
	} {
		rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp",
			map[string]any{"keys": []map[string]any{key(broken)}})

		if rec.Code < http.StatusBadRequest {
			t.Errorf("%s was accepted with %d", name, rec.Code)
		}
	}

	// An empty list would leave a connector that reads nothing, silently.
	if rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp",
		map[string]any{"keys": []map[string]any{}}); rec.Code < http.StatusBadRequest {
		t.Errorf("a connector was admitted with no keys: %d", rec.Code)
	}

	rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp",
		map[string]any{"keys": []map[string]any{key(nil)}})
	if rec.Code != http.StatusOK {
		t.Fatalf("a well-formed key was refused with %d: %s", rec.Code, rec.Body)
	}

	if len(service.lastKeys) != 1 || service.lastKeys[0].ScopeID != 11 {
		t.Errorf("the handler passed %+v", service.lastKeys)
	}
}

func TestFailuresMapOntoStatuses(t *testing.T) {
	for name, expected := range map[string]struct {
		err  error
		code int
	}{
		"a vault the caller cannot see": {domain.ErrNotFound, http.StatusNotFound},
		"a member who is not the owner": {domain.ErrOwnerRequired, http.StatusForbidden},
		"a vault already connected":     {domain.ErrExists, http.StatusConflict},
		"a key for a foreign scope":     {vault.ErrScopeMismatch, http.StatusConflict},
	} {
		router := newTestRouter(t, &stubService{err: expected.err})

		rec := do(t, router, http.MethodGet, "/api/v1/vaults/7/mcp", nil)
		if rec.Code != expected.code {
			t.Errorf("%s answered %d, want %d", name, rec.Code, expected.code)
		}
	}
}

// The credential exists in the clear exactly once, in this response.
func TestIssuedCredentialIsReturnedOnce(t *testing.T) {
	service := &stubService{issued: &domain.Issued{
		Token:  domain.Token{Kind: domain.KindStatic, Label: "laptop", ExpiresAt: time.Now().Add(time.Hour)},
		Secret: "a-secret-nobody-else-should-see",
	}}

	router := newTestRouter(t, service)

	rec := do(t, router, http.MethodPost, "/api/v1/vaults/7/mcp/credentials", map[string]any{"label": "laptop"})
	if rec.Code != http.StatusCreated {
		t.Fatalf("issuing answered %d: %s", rec.Code, rec.Body)
	}

	var issued struct {
		Secret string `json:"secret"`
		Kind   string `json:"kind"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &issued); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if issued.Secret != "a-secret-nobody-else-should-see" || issued.Kind != domain.KindStatic {
		t.Errorf("the response carried %+v", issued)
	}

	// Listing must never be a way to read one back.
	service.credentials = []domain.TokenSummary{{ID: 1, Kind: domain.KindStatic, Label: "laptop"}}

	listed := do(t, router, http.MethodGet, "/api/v1/vaults/7/mcp/credentials", nil)
	if bytes.Contains(listed.Body.Bytes(), []byte("a-secret-nobody-else-should-see")) {
		t.Fatal("the credential list gave the credential away")
	}
}

func TestDisableReportsWhatStillNeedsRotating(t *testing.T) {
	router := newTestRouter(t, &stubService{scopes: []int64{11, 12}})

	rec := do(t, router, http.MethodDelete, "/api/v1/vaults/7/mcp", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("disabling answered %d: %s", rec.Code, rec.Body)
	}

	var body struct {
		Scopes []int64 `json:"scopes_awaiting_rotation"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Revocation is immediate; rotation is what makes it retroactive, and the client is told
	// which scopes so it can offer that rather than leave it to be remembered.
	if len(body.Scopes) != 2 {
		t.Errorf("disabling reported %v", body.Scopes)
	}
}
