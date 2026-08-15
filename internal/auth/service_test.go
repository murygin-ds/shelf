package auth_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"shelf/internal/auth"

	"go.uber.org/zap"
)

// fakeRepo is a thread-safe in-memory implementation of auth.Repository.
type fakeRepo struct {
	mu            sync.Mutex
	users         []*auth.User
	recovery      map[int64]auth.RecoveryKey
	sessions      []*auth.Session
	tokenHashes   map[int64][]byte
	nextUserID    int64
	nextSessionID int64
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		recovery:    make(map[int64]auth.RecoveryKey),
		tokenHashes: make(map[int64][]byte),
	}
}

func (r *fakeRepo) CreateUser(_ context.Context, in auth.NewUser) (*auth.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, u := range r.users {
		if strings.EqualFold(u.Login, in.Login) {
			return nil, auth.ErrLoginTaken
		}
	}

	r.nextUserID++
	user := &auth.User{
		ID:        r.nextUserID,
		Login:     in.Login,
		AuthHash:  in.AuthHash,
		Keys:      in.Keys,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	recovery := in.Recovery
	recovery.UserID = user.ID

	r.users = append(r.users, user)
	r.recovery[user.ID] = recovery

	return user, nil
}

func (r *fakeRepo) UserByLogin(_ context.Context, login string) (*auth.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, u := range r.users {
		if strings.EqualFold(u.Login, login) {
			clone := *u
			return &clone, nil
		}
	}

	return nil, auth.ErrUserNotFound
}

func (r *fakeRepo) UserByID(_ context.Context, id int64) (*auth.User, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, u := range r.users {
		if u.ID == id {
			clone := *u
			return &clone, nil
		}
	}

	return nil, auth.ErrUserNotFound
}

func (r *fakeRepo) ResetCredentials(_ context.Context, userID int64, in auth.Credentials) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, u := range r.users {
		if u.ID != userID {
			continue
		}

		u.AuthHash = in.AuthHash
		u.Keys.KDFSalt = in.KDFSalt
		u.Keys.KDFParams = in.KDFParams
		u.Keys.WrappedMasterKey = in.WrappedMasterKey
		u.Keys.MasterKeyNonce = in.MasterKeyNonce

		if in.Recovery != nil {
			recovery := *in.Recovery
			recovery.UserID = userID
			r.recovery[userID] = recovery
		}

		r.revokeUserLocked(userID)

		return nil
	}

	return auth.ErrUserNotFound
}

func (r *fakeRepo) RecoveryKeyByLogin(ctx context.Context, login string) (*auth.RecoveryKey, error) {
	user, err := r.UserByLogin(ctx, login)
	if err != nil {
		return nil, err
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	key, ok := r.recovery[user.ID]
	if !ok {
		return nil, auth.ErrUserNotFound
	}

	return &key, nil
}

func (r *fakeRepo) CreateSession(_ context.Context, in auth.NewSession) (*auth.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.createSessionLocked(in), nil
}

func (r *fakeRepo) createSessionLocked(in auth.NewSession) *auth.Session {
	r.nextSessionID++
	session := &auth.Session{
		ID:         r.nextSessionID,
		UserID:     in.UserID,
		UserAgent:  in.UserAgent,
		IP:         in.IP,
		ExpiresAt:  in.ExpiresAt,
		CreatedAt:  time.Now(),
		LastUsedAt: time.Now(),
	}

	r.sessions = append(r.sessions, session)
	r.tokenHashes[session.ID] = in.TokenHash

	return session
}

func (r *fakeRepo) SessionByTokenHash(_ context.Context, tokenHash []byte) (*auth.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range r.sessions {
		if bytes.Equal(r.tokenHashes[s.ID], tokenHash) {
			clone := *s
			return &clone, nil
		}
	}

	return nil, auth.ErrSessionNotFound
}

func (r *fakeRepo) RotateSession(_ context.Context, oldID int64, in auth.NewSession) (*auth.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range r.sessions {
		if s.ID == oldID && s.RevokedAt == nil {
			now := time.Now()
			s.RevokedAt = &now

			return r.createSessionLocked(in), nil
		}
	}

	return nil, auth.ErrSessionNotFound
}

func (r *fakeRepo) RevokeSessionByTokenHash(_ context.Context, tokenHash []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range r.sessions {
		if bytes.Equal(r.tokenHashes[s.ID], tokenHash) && s.RevokedAt == nil {
			now := time.Now()
			s.RevokedAt = &now
		}
	}

	return nil
}

func (r *fakeRepo) RevokeSession(_ context.Context, userID, sessionID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, s := range r.sessions {
		if s.ID == sessionID && s.UserID == userID && s.RevokedAt == nil {
			now := time.Now()
			s.RevokedAt = &now

			return nil
		}
	}

	return auth.ErrSessionNotFound
}

func (r *fakeRepo) RevokeUserSessions(_ context.Context, userID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.revokeUserLocked(userID)

	return nil
}

func (r *fakeRepo) revokeUserLocked(userID int64) {
	now := time.Now()

	for _, s := range r.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			revoked := now
			s.RevokedAt = &revoked
		}
	}
}

func (r *fakeRepo) ListSessions(_ context.Context, userID int64) ([]auth.Session, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	var out []auth.Session

	for _, s := range r.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			out = append(out, *s)
		}
	}

	return out, nil
}

func newTestService(t *testing.T) (*auth.Service, *fakeRepo) {
	t.Helper()

	repo := newFakeRepo()

	return auth.NewService(repo, testAuthConfig(), zap.NewNop()), repo
}

// recoveryAuthHash is the recovery code verifier the client derives from it locally.
var recoveryAuthHash = []byte("recovery-auth-hash")

func testRegisterInput(login string) auth.RegisterInput {
	return auth.RegisterInput{
		Login:    login,
		AuthHash: []byte("client-auth-hash"),
		Keys: auth.KeyBundle{
			KDFSalt:           bytes.Repeat([]byte{1}, 16),
			KDFParams:         auth.DefaultKDFParams(),
			WrappedMasterKey:  bytes.Repeat([]byte{2}, 48),
			MasterKeyNonce:    bytes.Repeat([]byte{3}, 12),
			PublicKey:         bytes.Repeat([]byte{4}, 32),
			WrappedPrivateKey: bytes.Repeat([]byte{5}, 48),
			PrivateKeyNonce:   bytes.Repeat([]byte{6}, 12),
		},
		Recovery: auth.NewRecoveryKey{
			AuthHash:         recoveryAuthHash,
			WrappedMasterKey: bytes.Repeat([]byte{7}, 48),
			Nonce:            bytes.Repeat([]byte{8}, 12),
		},
	}
}

func TestRegisterStoresHashedSecret(t *testing.T) {
	t.Parallel()

	service, repo := newTestService(t)
	ctx := context.Background()
	authHash := []byte("client-auth-hash")

	user, pair, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	if user.AuthHash == string(authHash) {
		t.Fatal("Register() stored the client secret as is")
	}

	ok, err := auth.Verify(authHash, user.AuthHash)
	if err != nil || !ok {
		t.Fatalf("stored hash does not match the client secret: ok=%v err=%v", ok, err)
	}

	if pair.AccessToken == "" || pair.RefreshToken == "" {
		t.Fatal("Register() returned an empty token pair")
	}

	stored, err := repo.RecoveryKeyByLogin(ctx, "dmitry")
	if err != nil {
		t.Fatalf("recovery key was not saved: %v", err)
	}

	if stored.VerifierHash == string(recoveryAuthHash) {
		t.Fatal("Register() stored the recovery verifier as is")
	}

	if ok, err := auth.Verify(recoveryAuthHash, stored.VerifierHash); err != nil || !ok {
		t.Fatalf("stored recovery verifier does not match the code: ok=%v err=%v", ok, err)
	}

	if _, _, err := service.Register(ctx, testRegisterInput("DMITRY"), auth.ClientMeta{}); !errors.Is(err, auth.ErrLoginTaken) {
		t.Fatalf("Register() error = %v, want ErrLoginTaken for the same login in another case", err)
	}
}

func TestLogin(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()
	authHash := []byte("client-auth-hash")

	if _, _, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	user, pair, err := service.Login(ctx, "DmiTry", authHash, auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Login() error = %v", err)
	}

	if !bytes.Equal(user.Keys.WrappedMasterKey, bytes.Repeat([]byte{2}, 48)) {
		t.Error("Login() did not return the wrapped master key")
	}

	claims, err := service.ParseAccess(pair.AccessToken)
	if err != nil {
		t.Fatalf("ParseAccess() error = %v", err)
	}

	userID, err := claims.UserID()
	if err != nil || userID != user.ID {
		t.Fatalf("access token subject = %d (err %v), want %d", userID, err, user.ID)
	}

	if _, _, err := service.Login(ctx, "dmitry", []byte("wrong-secret"), auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("Login() error = %v, want ErrInvalidCredentials for a wrong secret", err)
	}

	if _, _, err := service.Login(ctx, "unknown", authHash, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Errorf("Login() error = %v, want ErrInvalidCredentials for an unknown login", err)
	}
}

func TestPreloginHidesMissingAccounts(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	if _, _, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	existing, err := service.Prelogin(ctx, "dmitry")
	if err != nil {
		t.Fatalf("Prelogin() error = %v", err)
	}

	if !bytes.Equal(existing.KDFSalt, bytes.Repeat([]byte{1}, 16)) {
		t.Error("Prelogin() did not return the stored salt")
	}

	missing, err := service.Prelogin(ctx, "ghost")
	if err != nil {
		t.Fatalf("Prelogin() error = %v", err)
	}

	if len(missing.KDFSalt) != len(existing.KDFSalt) {
		t.Fatalf("decoy salt length = %d, want %d", len(missing.KDFSalt), len(existing.KDFSalt))
	}

	repeated, err := service.Prelogin(ctx, "GHOST")
	if err != nil {
		t.Fatalf("Prelogin() error = %v", err)
	}

	if !bytes.Equal(missing.KDFSalt, repeated.KDFSalt) {
		t.Error("decoy salt is not stable across calls, missing accounts become distinguishable")
	}

	other, err := service.Prelogin(ctx, "phantom")
	if err != nil {
		t.Fatalf("Prelogin() error = %v", err)
	}

	if bytes.Equal(missing.KDFSalt, other.KDFSalt) {
		t.Error("decoy salt does not depend on the login")
	}
}

func TestRefreshRotatesAndDetectsReuse(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	user, pair, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	rotated, err := service.Refresh(ctx, pair.RefreshToken, auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if rotated.RefreshToken == pair.RefreshToken {
		t.Fatal("Refresh() reused the same refresh token")
	}

	// Presenting an already used token again is a sign of theft.
	if _, err := service.Refresh(ctx, pair.RefreshToken, auth.ClientMeta{}); !errors.Is(err, auth.ErrSessionReused) {
		t.Fatalf("Refresh() error = %v, want ErrSessionReused", err)
	}

	sessions, err := service.Sessions(ctx, user.ID)
	if err != nil {
		t.Fatalf("Sessions() error = %v", err)
	}

	if len(sessions) != 0 {
		t.Fatalf("active sessions = %d, want 0 after reuse detection", len(sessions))
	}

	if _, err := service.Refresh(ctx, rotated.RefreshToken, auth.ClientMeta{}); !errors.Is(err, auth.ErrSessionReused) {
		t.Fatalf("Refresh() error = %v, want ErrSessionReused for the revoked chain", err)
	}

	if _, err := service.Refresh(ctx, "unknown-token", auth.ClientMeta{}); !errors.Is(err, auth.ErrSessionNotFound) {
		t.Fatalf("Refresh() error = %v, want ErrSessionNotFound", err)
	}
}

func TestRecoveryRequiresValidCode(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	if _, _, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{}); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	if _, err := service.RecoveryStart(ctx, "dmitry", []byte("wrong-recovery-code")); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("RecoveryStart() error = %v, want ErrInvalidCredentials for a wrong code", err)
	}

	if _, err := service.RecoveryStart(ctx, "ghost", recoveryAuthHash); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("RecoveryStart() error = %v, want ErrInvalidCredentials for an unknown login", err)
	}

	challenge, err := service.RecoveryStart(ctx, "DmiTry", recoveryAuthHash)
	if err != nil {
		t.Fatalf("RecoveryStart() error = %v", err)
	}

	if !bytes.Equal(challenge.WrappedMasterKey, bytes.Repeat([]byte{7}, 48)) {
		t.Error("RecoveryStart() did not return the recovery-wrapped master key")
	}

	// A recovery token must not work as an access token.
	if _, err := service.ParseAccess(challenge.Token); !errors.Is(err, auth.ErrInvalidToken) {
		t.Errorf("ParseAccess() error = %v, want ErrInvalidToken for a recovery token", err)
	}

	creds := auth.CredentialsInput{
		AuthHash:         []byte("recovered-auth-hash"),
		KDFSalt:          bytes.Repeat([]byte{12}, 16),
		KDFParams:        auth.DefaultKDFParams(),
		WrappedMasterKey: bytes.Repeat([]byte{13}, 48),
		MasterKeyNonce:   bytes.Repeat([]byte{14}, 12),
		Recovery: &auth.NewRecoveryKey{
			AuthHash:         []byte("rotated-recovery-hash"),
			WrappedMasterKey: bytes.Repeat([]byte{15}, 48),
			Nonce:            bytes.Repeat([]byte{16}, 12),
		},
	}

	if _, err := service.RecoveryComplete(ctx, "not-a-token", creds, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("RecoveryComplete() error = %v, want ErrInvalidToken", err)
	}

	if _, err := service.RecoveryComplete(ctx, challenge.Token, creds, auth.ClientMeta{}); err != nil {
		t.Fatalf("RecoveryComplete() error = %v", err)
	}

	// The token is single-use: the credentials have changed, so a second reset with it fails.
	if _, err := service.RecoveryComplete(ctx, challenge.Token, creds, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("RecoveryComplete() error = %v, want ErrInvalidToken on token reuse", err)
	}

	if _, _, err := service.Login(ctx, "dmitry", []byte("recovered-auth-hash"), auth.ClientMeta{}); err != nil {
		t.Fatalf("Login() after recovery error = %v", err)
	}

	// The recovery code was rotated: the old one no longer matches, the new one works.
	if _, err := service.RecoveryStart(ctx, "dmitry", recoveryAuthHash); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Error("RecoveryStart() accepted the rotated-out recovery code")
	}

	if _, err := service.RecoveryStart(ctx, "dmitry", []byte("rotated-recovery-hash")); err != nil {
		t.Errorf("RecoveryStart() with the rotated code error = %v", err)
	}
}

func TestRecoveryTokenDiesWithPasswordChange(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	user, _, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	challenge, err := service.RecoveryStart(ctx, "dmitry", recoveryAuthHash)
	if err != nil {
		t.Fatalf("RecoveryStart() error = %v", err)
	}

	changed := auth.CredentialsInput{
		AuthHash:         []byte("changed-auth-hash"),
		KDFSalt:          bytes.Repeat([]byte{20}, 16),
		KDFParams:        auth.DefaultKDFParams(),
		WrappedMasterKey: bytes.Repeat([]byte{21}, 48),
		MasterKeyNonce:   bytes.Repeat([]byte{22}, 12),
	}

	if _, err := service.ChangePassword(ctx, user.ID, []byte("client-auth-hash"), changed, auth.ClientMeta{}); err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}

	// The token was issued before the password change and must not roll it back.
	if _, err := service.RecoveryComplete(ctx, challenge.Token, changed, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("RecoveryComplete() error = %v, want ErrInvalidToken for a stale token", err)
	}
}

func TestAccessTokenIsNotAcceptedAsRecovery(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()

	_, pair, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	creds := auth.CredentialsInput{
		AuthHash:         []byte("hijacked-auth-hash"),
		KDFSalt:          bytes.Repeat([]byte{17}, 16),
		KDFParams:        auth.DefaultKDFParams(),
		WrappedMasterKey: bytes.Repeat([]byte{18}, 48),
		MasterKeyNonce:   bytes.Repeat([]byte{19}, 12),
	}

	if _, err := service.RecoveryComplete(ctx, pair.AccessToken, creds, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidToken) {
		t.Fatalf("RecoveryComplete() error = %v, want ErrInvalidToken for an access token", err)
	}
}

func TestChangePasswordRevokesSessions(t *testing.T) {
	t.Parallel()

	service, _ := newTestService(t)
	ctx := context.Background()
	current := []byte("client-auth-hash")

	user, pair, err := service.Register(ctx, testRegisterInput("dmitry"), auth.ClientMeta{})
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	creds := auth.CredentialsInput{
		AuthHash:         []byte("new-auth-hash"),
		KDFSalt:          bytes.Repeat([]byte{9}, 16),
		KDFParams:        auth.DefaultKDFParams(),
		WrappedMasterKey: bytes.Repeat([]byte{10}, 48),
		MasterKeyNonce:   bytes.Repeat([]byte{11}, 12),
	}

	if _, err := service.ChangePassword(ctx, user.ID, []byte("wrong"), creds, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Fatalf("ChangePassword() error = %v, want ErrInvalidCredentials", err)
	}

	fresh, err := service.ChangePassword(ctx, user.ID, current, creds, auth.ClientMeta{})
	if err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}

	// The old refresh token belongs to a revoked session.
	if _, err := service.Refresh(ctx, pair.RefreshToken, auth.ClientMeta{}); !errors.Is(err, auth.ErrSessionReused) {
		t.Fatalf("Refresh() error = %v, want revoked old session", err)
	}

	if _, _, err := service.Login(ctx, "dmitry", []byte("new-auth-hash"), auth.ClientMeta{}); err != nil {
		t.Fatalf("Login() with the new secret error = %v", err)
	}

	if _, _, err := service.Login(ctx, "dmitry", current, auth.ClientMeta{}); !errors.Is(err, auth.ErrInvalidCredentials) {
		t.Error("Login() with the old secret succeeded after password change")
	}

	if fresh.AccessToken == "" {
		t.Error("ChangePassword() returned an empty access token")
	}
}
