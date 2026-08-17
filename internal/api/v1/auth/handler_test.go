package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	handler "shelf/internal/api/v1/auth"
	"shelf/internal/auth"
	"shelf/internal/config"
	"shelf/internal/ratelimit"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// stubService replaces the business logic: the handler only cares about response codes and error mapping.
type stubService struct {
	tokens *auth.TokenManager

	registerErr error
	loginErr    error
	recoveryErr error
	deleteErr   error
	user        *auth.User
}

func (s *stubService) pair() auth.TokenPair {
	access, expiresAt, _ := s.tokens.IssueAccess(1, 1, time.Now())

	return auth.TokenPair{
		AccessToken:      access,
		AccessExpiresAt:  expiresAt,
		RefreshToken:     "refresh-token-value-0123456789",
		RefreshExpiresAt: time.Now().Add(time.Hour),
	}
}

func (s *stubService) ParseAccess(token string) (*auth.Claims, error) {
	return s.tokens.ParseAccess(token)
}

func (s *stubService) Register(context.Context, auth.RegisterInput, auth.ClientMeta) (*auth.User, auth.TokenPair, error) {
	if s.registerErr != nil {
		return nil, auth.TokenPair{}, s.registerErr
	}

	return s.user, s.pair(), nil
}

func (s *stubService) Prelogin(context.Context, string) (auth.Prelogin, error) {
	return auth.Prelogin{KDFSalt: bytes.Repeat([]byte{1}, 16), KDFParams: auth.DefaultKDFParams()}, nil
}

func (s *stubService) Login(context.Context, string, []byte, auth.ClientMeta) (*auth.User, auth.TokenPair, error) {
	if s.loginErr != nil {
		return nil, auth.TokenPair{}, s.loginErr
	}

	return s.user, s.pair(), nil
}

func (s *stubService) Refresh(context.Context, string, auth.ClientMeta) (auth.TokenPair, error) {
	return s.pair(), nil
}

func (s *stubService) Logout(context.Context, string) error { return nil }

func (s *stubService) LogoutAll(context.Context, int64) error { return nil }

func (s *stubService) User(context.Context, int64) (*auth.User, error) { return s.user, nil }

func (s *stubService) UpdateDisplayName(_ context.Context, _ int64, displayName string) (*auth.User, error) {
	if strings.TrimSpace(displayName) == "" {
		return nil, auth.ErrBlankDisplayName
	}

	renamed := *s.user
	renamed.DisplayName = displayName

	return &renamed, nil
}

func (s *stubService) DeleteAccount(context.Context, int64, []byte) error { return s.deleteErr }

func (s *stubService) Sessions(context.Context, int64) ([]auth.Session, error) { return nil, nil }

func (s *stubService) RevokeSession(context.Context, int64, int64) error { return nil }

func (s *stubService) ChangePassword(
	context.Context, int64, []byte, auth.CredentialsInput, auth.ClientMeta,
) (auth.TokenPair, error) {
	return s.pair(), nil
}

func (s *stubService) RecoveryStart(context.Context, string, []byte) (*auth.RecoveryChallenge, error) {
	if s.recoveryErr != nil {
		return nil, s.recoveryErr
	}

	return &auth.RecoveryChallenge{
		WrappedMasterKey: bytes.Repeat([]byte{7}, 48),
		Nonce:            bytes.Repeat([]byte{8}, 12),
		Token:            "recovery-token",
		ExpiresAt:        time.Now().Add(10 * time.Minute),
	}, nil
}

func (s *stubService) RecoveryComplete(
	context.Context, string, auth.CredentialsInput, auth.ClientMeta,
) (auth.TokenPair, error) {
	return s.pair(), nil
}

func newTestRouter(t *testing.T, service *stubService) *gin.Engine {
	t.Helper()

	return newLimitedRouter(t, service, handler.Limits{})
}

func newLimitedRouter(t *testing.T, service *stubService, limits handler.Limits) *gin.Engine {
	t.Helper()

	gin.SetMode(gin.TestMode)

	router := gin.New()
	handler.NewHandler(service, limits, zap.NewNop()).RegisterRoutes(router.Group("/api/v1"))

	return router
}

func newStubService(t *testing.T) *stubService {
	t.Helper()

	cfg := config.Auth{
		Secret:     "0123456789abcdef0123456789abcdef",
		Issuer:     "shelf-test",
		AccessTTL:  time.Minute,
		RefreshTTL: time.Hour,
	}

	return &stubService{
		tokens: auth.NewTokenManager(cfg),
		user: &auth.User{
			ID:    1,
			Login: "dmitry",
			Keys: auth.KeyBundle{
				KDFSalt:           bytes.Repeat([]byte{1}, 16),
				KDFParams:         auth.DefaultKDFParams(),
				WrappedMasterKey:  bytes.Repeat([]byte{2}, 48),
				MasterKeyNonce:    bytes.Repeat([]byte{3}, 12),
				PublicKey:         bytes.Repeat([]byte{4}, 32),
				WrappedPrivateKey: bytes.Repeat([]byte{5}, 48),
				PrivateKeyNonce:   bytes.Repeat([]byte{6}, 12),
			},
			CreatedAt: time.Now(),
		},
	}
}

func validRegisterBody() map[string]any {
	b64 := func(n int, fill byte) []byte { return bytes.Repeat([]byte{fill}, n) }

	return map[string]any{
		"login":        "dmitry",
		"display_name": "Dmitry Murygin",
		"auth_hash":    b64(32, 1),
		"kdf_salt":     b64(16, 2),
		"kdf_params": map[string]any{
			"algorithm": "argon2id", "memory": 65536, "iterations": 3, "parallelism": 2,
		},
		"wrapped_master_key":  b64(48, 3),
		"master_key_nonce":    b64(12, 4),
		"public_key":          b64(32, 5),
		"wrapped_private_key": b64(48, 6),
		"private_key_nonce":   b64(12, 7),
		"recovery": map[string]any{
			"auth_hash":          b64(32, 10),
			"wrapped_master_key": b64(48, 8),
			"nonce":              b64(12, 9),
		},
	}
}

func doJSON(t *testing.T, router *gin.Engine, method, path string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()

	var payload []byte

	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}

		payload = encoded
	}

	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")

	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	return rec
}

func TestRegisterEndpoint(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	router := newTestRouter(t, service)

	rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/register", validRegisterBody(), "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusCreated, rec.Body)
	}

	var body handler.SessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if body.Tokens.AccessToken == "" || body.Tokens.TokenType != "Bearer" {
		t.Errorf("tokens = %+v, want a filled Bearer pair", body.Tokens)
	}

	if !bytes.Equal(body.Keys.WrappedMasterKey, bytes.Repeat([]byte{2}, 48)) {
		t.Error("response does not contain the wrapped master key")
	}
}

func TestRegisterEndpointErrors(t *testing.T) {
	t.Parallel()

	t.Run("login is taken", func(t *testing.T) {
		t.Parallel()

		service := newStubService(t)
		service.registerErr = auth.ErrLoginTaken

		rec := doJSON(t, newTestRouter(t, service), http.MethodPost, "/api/v1/auth/register", validRegisterBody(), "")
		if rec.Code != http.StatusConflict {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
		}
	})

	invalid := map[string]func(map[string]any){
		"short login":              func(b map[string]any) { b["login"] = "ab" },
		"no display_name":          func(b map[string]any) { delete(b, "display_name") },
		"overlong display_name":    func(b map[string]any) { b["display_name"] = strings.Repeat("a", 129) },
		"no auth_hash":             func(b map[string]any) { delete(b, "auth_hash") },
		"short salt":               func(b map[string]any) { b["kdf_salt"] = bytes.Repeat([]byte{1}, 4) },
		"weak kdf_params":          func(b map[string]any) { b["kdf_params"].(map[string]any)["memory"] = 1024 },
		"no recovery key":          func(b map[string]any) { delete(b, "recovery") },
		"no recovery verifier":     func(b map[string]any) { delete(b["recovery"].(map[string]any), "auth_hash") },
		"foreign algorithm in kdf": func(b map[string]any) { b["kdf_params"].(map[string]any)["algorithm"] = "scrypt" },
	}

	for name, corrupt := range invalid {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			body := validRegisterBody()
			corrupt(body)

			rec := doJSON(t, newTestRouter(t, newStubService(t)), http.MethodPost, "/api/v1/auth/register", body, "")
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}
		})
	}
}

func TestLoginEndpointRejectsBadCredentials(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.loginErr = auth.ErrInvalidCredentials

	body := map[string]any{"login": "dmitry", "auth_hash": bytes.Repeat([]byte{1}, 32)}

	rec := doJSON(t, newTestRouter(t, service), http.MethodPost, "/api/v1/auth/login", body, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRecoveryStartEndpoint(t *testing.T) {
	t.Parallel()

	body := map[string]any{"login": "dmitry", "recovery_auth_hash": bytes.Repeat([]byte{1}, 32)}

	rec := doJSON(t, newTestRouter(t, newStubService(t)), http.MethodPost, "/api/v1/auth/recovery/start", body, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var challenge handler.RecoveryChallengeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &challenge); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if challenge.RecoveryToken == "" {
		t.Error("response does not contain a recovery token")
	}

	t.Run("wrong recovery code", func(t *testing.T) {
		t.Parallel()

		service := newStubService(t)
		service.recoveryErr = auth.ErrInvalidCredentials

		rec := doJSON(t, newTestRouter(t, service), http.MethodPost, "/api/v1/auth/recovery/start", body, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("without a verifier", func(t *testing.T) {
		t.Parallel()

		rec := doJSON(t, newTestRouter(t, newStubService(t)), http.MethodPost,
			"/api/v1/auth/recovery/start", map[string]any{"login": "dmitry"}, "")
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnprocessableEntity)
		}
	})
}

func TestLoginRateLimit(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.loginErr = auth.ErrInvalidCredentials

	router := newLimitedRouter(t, service, handler.Limits{
		LoginIP:      ratelimit.New(3, time.Minute),
		LoginAccount: ratelimit.New(10, time.Minute),
	})

	body := map[string]any{"login": "dmitry", "auth_hash": bytes.Repeat([]byte{1}, 32)}

	for i := range 3 {
		if rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want %d", i+1, rec.Code, http.StatusUnauthorized)
		}
	}

	rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, "")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}

	if retryAfter := rec.Header().Get("Retry-After"); retryAfter == "" {
		t.Error("response has no Retry-After header")
	}
}

func TestLoginRateLimitPerAccount(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.loginErr = auth.ErrInvalidCredentials

	// The per-address limit is deliberately out of the way: the account counter is the one that must trip.
	router := newLimitedRouter(t, service, handler.Limits{
		LoginIP:      ratelimit.New(100, time.Minute),
		LoginAccount: ratelimit.New(2, time.Minute),
	})

	attempt := func(login string) int {
		body := map[string]any{"login": login, "auth_hash": bytes.Repeat([]byte{1}, 32)}

		return doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, "").Code
	}

	if code := attempt("dmitry"); code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", code, http.StatusUnauthorized)
	}

	// The login case must not reset the counter.
	if code := attempt("DMITRY"); code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", code, http.StatusUnauthorized)
	}

	if code := attempt("dmitry"); code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", code, http.StatusTooManyRequests)
	}

	// Another account is counted separately.
	if code := attempt("someone-else"); code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d for another account", code, http.StatusUnauthorized)
	}
}

// TestAnAccountCannotBeLockedOut pins the reason the account counter is applied after the
// credentials rather than before: otherwise anybody who knows a login could keep its owner
// out for the window by guessing wrong, over and over.
func TestAnAccountCannotBeLockedOut(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.loginErr = auth.ErrInvalidCredentials

	router := newLimitedRouter(t, service, handler.Limits{
		LoginIP:      ratelimit.New(100, time.Minute),
		LoginAccount: ratelimit.New(2, time.Minute),
	})

	body := map[string]any{"login": "dmitry", "auth_hash": bytes.Repeat([]byte{1}, 32)}

	// An attacker empties the account's bucket.
	for range 3 {
		doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, "")
	}

	// The owner arrives with the right passphrase and must still get in.
	service.loginErr = nil

	if rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, ""); rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d — the account was locked out by somebody else's guesses",
			rec.Code, http.StatusOK)
	}
}

func TestSuccessfulLoginDoesNotSpendAttempts(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	router := newLimitedRouter(t, service, handler.Limits{
		LoginIP:      ratelimit.New(2, time.Minute),
		LoginAccount: ratelimit.New(2, time.Minute),
	})

	body := map[string]any{"login": "dmitry", "auth_hash": bytes.Repeat([]byte{1}, 32)}

	for i := range 5 {
		if rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, ""); rec.Code != http.StatusOK {
			t.Fatalf("attempt %d: status = %d, want %d", i+1, rec.Code, http.StatusOK)
		}
	}
}

func TestRecoveryStartRateLimit(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.recoveryErr = auth.ErrInvalidCredentials

	router := newLimitedRouter(t, service, handler.Limits{
		RecoveryIP:      ratelimit.New(2, time.Minute),
		RecoveryAccount: ratelimit.New(10, time.Minute),
	})

	body := map[string]any{"login": "dmitry", "recovery_auth_hash": bytes.Repeat([]byte{1}, 32)}

	for i := range 2 {
		rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/recovery/start", body, "")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want %d", i+1, rec.Code, http.StatusUnauthorized)
		}
	}

	rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/recovery/start", body, "")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusTooManyRequests)
	}

	var body429 struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}

	if err := json.Unmarshal(rec.Body.Bytes(), &body429); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if body429.Error.Code != "too_many_requests" {
		t.Errorf("error code = %q, want %q", body429.Error.Code, "too_many_requests")
	}
}

func TestUnlimitedByDefault(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	service.loginErr = auth.ErrInvalidCredentials

	router := newTestRouter(t, service)
	body := map[string]any{"login": "dmitry", "auth_hash": bytes.Repeat([]byte{1}, 32)}

	for i := range 20 {
		if rec := doJSON(t, router, http.MethodPost, "/api/v1/auth/login", body, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want %d with limits disabled", i+1, rec.Code, http.StatusUnauthorized)
		}
	}
}

func TestProtectedRoutesRequireToken(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	router := newTestRouter(t, service)

	if rec := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", nil, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status without token = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	if rec := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", nil, "garbage"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status with a broken token = %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	access, _, err := service.tokens.IssueAccess(1, 1, time.Now())
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	rec := doJSON(t, router, http.MethodGet, "/api/v1/auth/me", nil, access)
	if rec.Code != http.StatusOK {
		t.Fatalf("status with a valid token = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body handler.UserResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if body.Login != "dmitry" {
		t.Errorf("login = %q, want %q", body.Login, "dmitry")
	}
}

func TestUpdateProfileEndpoint(t *testing.T) {
	t.Parallel()

	service := newStubService(t)
	router := newTestRouter(t, service)

	access, _, err := service.tokens.IssueAccess(1, 1, time.Now())
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	rec := doJSON(t, router, http.MethodPatch, "/api/v1/auth/me",
		map[string]any{"display_name": "Dmitry M."}, access)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusOK, rec.Body)
	}

	var body handler.UserResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if body.DisplayName != "Dmitry M." {
		t.Errorf("display_name = %q, want %q", body.DisplayName, "Dmitry M.")
	}

	invalid := map[string]any{
		"blank":    map[string]any{"display_name": "   "},
		"missing":  map[string]any{},
		"overlong": map[string]any{"display_name": strings.Repeat("a", 129)},
	}

	for name, payload := range invalid {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			rec := doJSON(t, router, http.MethodPatch, "/api/v1/auth/me", payload, access)
			if rec.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnprocessableEntity, rec.Body)
			}
		})
	}
}

func TestDeleteAccountEndpoint(t *testing.T) {
	t.Parallel()

	body := map[string]any{"auth_hash": bytes.Repeat([]byte{1}, 32)}

	t.Run("password proof is required", func(t *testing.T) {
		t.Parallel()

		service := newStubService(t)
		router := newTestRouter(t, service)

		access, _, err := service.tokens.IssueAccess(1, 1, time.Now())
		if err != nil {
			t.Fatalf("IssueAccess() error = %v", err)
		}

		if rec := doJSON(t, router, http.MethodDelete, "/api/v1/auth/me", map[string]any{}, access); rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status without auth_hash = %d, want %d", rec.Code, http.StatusUnprocessableEntity)
		}

		if rec := doJSON(t, router, http.MethodDelete, "/api/v1/auth/me", body, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("status without a token = %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("a wrong password is refused", func(t *testing.T) {
		t.Parallel()

		service := newStubService(t)
		service.deleteErr = auth.ErrInvalidCredentials

		access, _, err := service.tokens.IssueAccess(1, 1, time.Now())
		if err != nil {
			t.Fatalf("IssueAccess() error = %v", err)
		}

		rec := doJSON(t, newTestRouter(t, service), http.MethodDelete, "/api/v1/auth/me", body, access)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusUnauthorized, rec.Body)
		}
	})

	t.Run("the account goes", func(t *testing.T) {
		t.Parallel()

		service := newStubService(t)

		access, _, err := service.tokens.IssueAccess(1, 1, time.Now())
		if err != nil {
			t.Fatalf("IssueAccess() error = %v", err)
		}

		rec := doJSON(t, newTestRouter(t, service), http.MethodDelete, "/api/v1/auth/me", body, access)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusNoContent, rec.Body)
		}
	})
}
