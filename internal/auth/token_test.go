package auth_test

import (
	"bytes"
	"errors"
	"testing"
	"time"

	"shelf/internal/auth"
	"shelf/internal/config"
)

func testAuthConfig() config.Auth {
	return config.Auth{
		Secret:      "0123456789abcdef0123456789abcdef",
		Issuer:      "shelf-test",
		AccessTTL:   15 * time.Minute,
		RefreshTTL:  24 * time.Hour,
		RecoveryTTL: 10 * time.Minute,
		Argon2:      testArgon2(),
	}
}

func TestIssueAndParseAccess(t *testing.T) {
	t.Parallel()

	manager := auth.NewTokenManager(testAuthConfig())
	now := time.Now()

	token, expiresAt, err := manager.IssueAccess(42, 7, now)
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	// exp is stored in seconds inside a JWT, so the returned time is truncated.
	if want := now.Add(15 * time.Minute).Truncate(time.Second); !expiresAt.Equal(want) {
		t.Fatalf("expiresAt = %v, want %v", expiresAt, want)
	}

	claims, err := manager.ParseAccess(token)
	if err != nil {
		t.Fatalf("ParseAccess() error = %v", err)
	}

	userID, err := claims.UserID()
	if err != nil {
		t.Fatalf("UserID() error = %v", err)
	}

	if userID != 42 {
		t.Errorf("UserID() = %d, want 42", userID)
	}

	if claims.SessionID != 7 {
		t.Errorf("SessionID = %d, want 7", claims.SessionID)
	}
}

func TestParseAccessRejectsForeignAndExpired(t *testing.T) {
	t.Parallel()

	manager := auth.NewTokenManager(testAuthConfig())

	foreignCfg := testAuthConfig()
	foreignCfg.Secret = "ffffffffffffffffffffffffffffffff"
	foreign := auth.NewTokenManager(foreignCfg)

	token, _, err := foreign.IssueAccess(1, 1, time.Now())
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	if _, err := manager.ParseAccess(token); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("ParseAccess() error = %v, want ErrInvalidToken for foreign signature", err)
	}

	expired, _, err := manager.IssueAccess(1, 1, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	if _, err := manager.ParseAccess(expired); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("ParseAccess() error = %v, want ErrInvalidToken for expired token", err)
	}

	if _, err := manager.ParseAccess("not-a-jwt"); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("ParseAccess() error = %v, want ErrInvalidToken for garbage", err)
	}
}

func TestRecoveryTokenScopeIsIsolated(t *testing.T) {
	t.Parallel()

	manager := auth.NewTokenManager(testAuthConfig())
	now := time.Now()

	recovery, expiresAt, err := manager.IssueRecovery(42, "fingerprint-value", now)
	if err != nil {
		t.Fatalf("IssueRecovery() error = %v", err)
	}

	if want := now.Add(10 * time.Minute).Truncate(time.Second); !expiresAt.Equal(want) {
		t.Fatalf("expiresAt = %v, want %v", expiresAt, want)
	}

	claims, err := manager.ParseRecovery(recovery)
	if err != nil {
		t.Fatalf("ParseRecovery() error = %v", err)
	}

	if userID, err := claims.UserID(); err != nil || userID != 42 {
		t.Fatalf("UserID() = %d (err %v), want 42", userID, err)
	}

	if claims.Fingerprint != "fingerprint-value" {
		t.Errorf("Fingerprint = %q, want %q", claims.Fingerprint, "fingerprint-value")
	}

	if _, err := manager.ParseAccess(recovery); !errors.Is(err, auth.ErrInvalidToken) {
		t.Error("ParseAccess() accepted a recovery token")
	}

	access, _, err := manager.IssueAccess(42, 1, now)
	if err != nil {
		t.Fatalf("IssueAccess() error = %v", err)
	}

	if _, err := manager.ParseRecovery(access); !errors.Is(err, auth.ErrInvalidToken) {
		t.Error("ParseRecovery() accepted an access token")
	}
}

func TestRefreshTokenIsRandomAndHashed(t *testing.T) {
	t.Parallel()

	first, err := auth.NewRefreshToken()
	if err != nil {
		t.Fatalf("NewRefreshToken() error = %v", err)
	}

	second, err := auth.NewRefreshToken()
	if err != nil {
		t.Fatalf("NewRefreshToken() error = %v", err)
	}

	if first == second {
		t.Fatal("NewRefreshToken() returned identical tokens")
	}

	hash := auth.HashRefreshToken(first)
	if len(hash) != 32 {
		t.Fatalf("HashRefreshToken() length = %d, want 32", len(hash))
	}

	if !bytes.Equal(hash, auth.HashRefreshToken(first)) {
		t.Fatal("HashRefreshToken() is not deterministic")
	}

	if bytes.Equal(hash, auth.HashRefreshToken(second)) {
		t.Fatal("HashRefreshToken() collided on different tokens")
	}
}
