package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"shelf/internal/config"

	"go.uber.org/zap"
)

// The labels separate the purposes of the root secret: every subkey is derived by its own HMAC.
const (
	preloginSaltLabel        = "shelf/prelogin-salt/v1"
	recoveryFingerprintLabel = "shelf/recovery-fingerprint/v1"
)

// preloginSaltLength is the length of the returned salt, matching a typical client-side one.
const preloginSaltLength = 16

// fingerprintLength is the length of the credentials fingerprint in a recovery token.
const fingerprintLength = 16

// Prelogin holds the key derivation parameters the client needs before sending auth_hash.
type Prelogin struct {
	KDFSalt   []byte
	KDFParams KDFParams
}

// RecoveryChallenge is the result of a successful recovery code check.
type RecoveryChallenge struct {
	WrappedMasterKey []byte
	Nonce            []byte
	Token            string
	ExpiresAt        time.Time
}

// Service holds the business logic of registration, login and session handling.
type Service struct {
	repo           Repository
	tokens         *TokenManager
	hasher         Hasher
	preloginKey    []byte
	fingerprintKey []byte
	log            *zap.Logger
}

// NewService assembles the authentication service.
func NewService(repo Repository, cfg config.Auth, log *zap.Logger) *Service {
	return &Service{
		repo:           repo,
		tokens:         NewTokenManager(cfg),
		hasher:         NewHasher(cfg.Argon2),
		preloginKey:    deriveKey(cfg.Secret, preloginSaltLabel),
		fingerprintKey: deriveKey(cfg.Secret, recoveryFingerprintLabel),
		log:            log,
	}
}

func deriveKey(secret, label string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(label))

	return mac.Sum(nil)
}

// ParseAccess validates an access token. Used by the HTTP middleware.
func (s *Service) ParseAccess(token string) (*Claims, error) {
	return s.tokens.ParseAccess(token)
}

// Register creates an account together with its recovery key and opens a session.
func (s *Service) Register(ctx context.Context, in RegisterInput, meta ClientMeta) (*User, TokenPair, error) {
	authHash, err := s.hasher.Hash(in.AuthHash)
	if err != nil {
		return nil, TokenPair{}, fmt.Errorf("hash auth secret: %w", err)
	}

	recovery, err := s.hashRecovery(in.Recovery)
	if err != nil {
		return nil, TokenPair{}, err
	}

	user, err := s.repo.CreateUser(ctx, NewUser{
		Login:    strings.TrimSpace(in.Login),
		AuthHash: authHash,
		Keys:     in.Keys,
		Recovery: *recovery,
	})
	if err != nil {
		return nil, TokenPair{}, err
	}

	tokens, err := s.issueSession(ctx, user.ID, meta)
	if err != nil {
		return nil, TokenPair{}, err
	}

	return user, tokens, nil
}

// Prelogin returns the salt and the KDF parameters for a login.
//
// For a login that does not exist it returns deterministic pseudorandom values:
// otherwise the endpoint would turn into an account existence oracle.
func (s *Service) Prelogin(ctx context.Context, login string) (Prelogin, error) {
	user, err := s.repo.UserByLogin(ctx, login)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return Prelogin{KDFSalt: s.decoySalt(login), KDFParams: DefaultKDFParams()}, nil
		}

		return Prelogin{}, err
	}

	return Prelogin{KDFSalt: user.Keys.KDFSalt, KDFParams: user.Keys.KDFParams}, nil
}

// Login verifies auth_hash and returns the wrapped keys together with a token pair.
func (s *Service) Login(ctx context.Context, login string, authHash []byte, meta ClientMeta) (*User, TokenPair, error) {
	user, err := s.repo.UserByLogin(ctx, login)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			// Compute a throwaway hash so the response takes as long as a real verification.
			s.hasher.DummyVerify(authHash)

			return nil, TokenPair{}, ErrInvalidCredentials
		}

		return nil, TokenPair{}, err
	}

	ok, err := Verify(authHash, user.AuthHash)
	if err != nil {
		return nil, TokenPair{}, fmt.Errorf("verify auth secret: %w", err)
	}

	if !ok {
		return nil, TokenPair{}, ErrInvalidCredentials
	}

	tokens, err := s.issueSession(ctx, user.ID, meta)
	if err != nil {
		return nil, TokenPair{}, err
	}

	return user, tokens, nil
}

// Refresh exchanges a refresh token for a new pair, rotating the session.
// Presenting an already used token again revokes all sessions of the user.
func (s *Service) Refresh(ctx context.Context, refreshToken string, meta ClientMeta) (TokenPair, error) {
	session, err := s.repo.SessionByTokenHash(ctx, HashRefreshToken(refreshToken))
	if err != nil {
		return TokenPair{}, err
	}

	if session.RevokedAt != nil {
		if err := s.repo.RevokeUserSessions(ctx, session.UserID); err != nil {
			return TokenPair{}, err
		}

		s.log.Warn("refresh token reuse detected, all sessions revoked",
			zap.Int64("user_id", session.UserID),
			zap.Int64("session_id", session.ID),
		)

		return TokenPair{}, ErrSessionReused
	}

	if time.Now().After(session.ExpiresAt) {
		return TokenPair{}, ErrSessionNotFound
	}

	token, err := NewRefreshToken()
	if err != nil {
		return TokenPair{}, err
	}

	now := time.Now()

	rotated, err := s.repo.RotateSession(ctx, session.ID, NewSession{
		UserID:    session.UserID,
		TokenHash: HashRefreshToken(token),
		UserAgent: meta.UserAgent,
		IP:        meta.IP,
		ExpiresAt: now.Add(s.tokens.RefreshTTL()),
	})
	if err != nil {
		return TokenPair{}, err
	}

	return s.pair(rotated, token, now)
}

// Logout revokes the session the refresh token belongs to. An unknown token is not an error.
func (s *Service) Logout(ctx context.Context, refreshToken string) error {
	return s.repo.RevokeSessionByTokenHash(ctx, HashRefreshToken(refreshToken))
}

// LogoutAll revokes all sessions of the user.
func (s *Service) LogoutAll(ctx context.Context, userID int64) error {
	return s.repo.RevokeUserSessions(ctx, userID)
}

// User returns the account by its identifier.
func (s *Service) User(ctx context.Context, userID int64) (*User, error) {
	return s.repo.UserByID(ctx, userID)
}

// Sessions returns the active sessions of the user.
func (s *Service) Sessions(ctx context.Context, userID int64) ([]Session, error) {
	return s.repo.ListSessions(ctx, userID)
}

// RevokeSession revokes one particular session of the user.
func (s *Service) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	return s.repo.RevokeSession(ctx, userID, sessionID)
}

// ChangePassword replaces the authentication data when the current password is known:
// the client re-encrypts the master key with the new wrapping key and sends the result.
// All previous sessions are revoked and a new one is opened instead.
func (s *Service) ChangePassword(
	ctx context.Context,
	userID int64,
	currentAuthHash []byte,
	in CredentialsInput,
	meta ClientMeta,
) (TokenPair, error) {
	user, err := s.repo.UserByID(ctx, userID)
	if err != nil {
		return TokenPair{}, err
	}

	ok, err := Verify(currentAuthHash, user.AuthHash)
	if err != nil {
		return TokenPair{}, fmt.Errorf("verify auth secret: %w", err)
	}

	if !ok {
		return TokenPair{}, ErrInvalidCredentials
	}

	return s.resetCredentials(ctx, user.ID, in, meta)
}

// RecoveryStart verifies ownership of the recovery code and returns the master key
// wrapped with it, together with a short-lived token for completing the recovery.
//
// The wrapped key is handed out only after the verifier check: otherwise it could be
// pulled with nothing but a login and the recovery code guessed offline.
func (s *Service) RecoveryStart(ctx context.Context, login string, recoveryAuthHash []byte) (*RecoveryChallenge, error) {
	key, err := s.repo.RecoveryKeyByLogin(ctx, login)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			s.hasher.DummyVerify(recoveryAuthHash)

			return nil, ErrInvalidCredentials
		}

		return nil, err
	}

	ok, err := Verify(recoveryAuthHash, key.VerifierHash)
	if err != nil {
		return nil, fmt.Errorf("verify recovery secret: %w", err)
	}

	if !ok {
		return nil, ErrInvalidCredentials
	}

	user, err := s.repo.UserByID(ctx, key.UserID)
	if err != nil {
		return nil, err
	}

	token, expiresAt, err := s.tokens.IssueRecovery(user.ID, s.fingerprint(user.AuthHash), time.Now())
	if err != nil {
		return nil, err
	}

	return &RecoveryChallenge{
		WrappedMasterKey: key.WrappedMasterKey,
		Nonce:            key.Nonce,
		Token:            token,
		ExpiresAt:        expiresAt,
	}, nil
}

// RecoveryComplete sets the new authentication data using the token issued by
// RecoveryStart: the master key is the same, but wrapped with a key from the new password.
//
// The token is single-use: it is bound to the credentials in effect when it was issued,
// so after a successful reset (or a password change by another route) it no longer matches.
func (s *Service) RecoveryComplete(
	ctx context.Context,
	recoveryToken string,
	in CredentialsInput,
	meta ClientMeta,
) (TokenPair, error) {
	claims, err := s.tokens.ParseRecovery(recoveryToken)
	if err != nil {
		return TokenPair{}, err
	}

	userID, err := claims.UserID()
	if err != nil {
		return TokenPair{}, err
	}

	user, err := s.repo.UserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrUserNotFound) {
			return TokenPair{}, fmt.Errorf("%w: unknown subject", ErrInvalidToken)
		}

		return TokenPair{}, err
	}

	if !hmac.Equal([]byte(claims.Fingerprint), []byte(s.fingerprint(user.AuthHash))) {
		return TokenPair{}, fmt.Errorf("%w: credentials have already changed", ErrInvalidToken)
	}

	return s.resetCredentials(ctx, user.ID, in, meta)
}

func (s *Service) resetCredentials(
	ctx context.Context,
	userID int64,
	in CredentialsInput,
	meta ClientMeta,
) (TokenPair, error) {
	authHash, err := s.hasher.Hash(in.AuthHash)
	if err != nil {
		return TokenPair{}, fmt.Errorf("hash auth secret: %w", err)
	}

	creds := Credentials{
		AuthHash:         authHash,
		KDFSalt:          in.KDFSalt,
		KDFParams:        in.KDFParams,
		WrappedMasterKey: in.WrappedMasterKey,
		MasterKeyNonce:   in.MasterKeyNonce,
	}

	if in.Recovery != nil {
		recovery, err := s.hashRecovery(*in.Recovery)
		if err != nil {
			return TokenPair{}, err
		}

		creds.Recovery = recovery
	}

	if err := s.repo.ResetCredentials(ctx, userID, creds); err != nil {
		return TokenPair{}, err
	}

	return s.issueSession(ctx, userID, meta)
}

func (s *Service) hashRecovery(in NewRecoveryKey) (*RecoveryKey, error) {
	verifier, err := s.hasher.Hash(in.AuthHash)
	if err != nil {
		return nil, fmt.Errorf("hash recovery secret: %w", err)
	}

	return &RecoveryKey{
		VerifierHash:     verifier,
		WrappedMasterKey: in.WrappedMasterKey,
		Nonce:            in.Nonce,
	}, nil
}

func (s *Service) issueSession(ctx context.Context, userID int64, meta ClientMeta) (TokenPair, error) {
	token, err := NewRefreshToken()
	if err != nil {
		return TokenPair{}, err
	}

	now := time.Now()

	session, err := s.repo.CreateSession(ctx, NewSession{
		UserID:    userID,
		TokenHash: HashRefreshToken(token),
		UserAgent: meta.UserAgent,
		IP:        meta.IP,
		ExpiresAt: now.Add(s.tokens.RefreshTTL()),
	})
	if err != nil {
		return TokenPair{}, err
	}

	return s.pair(session, token, now)
}

func (s *Service) pair(session *Session, refreshToken string, now time.Time) (TokenPair, error) {
	access, expiresAt, err := s.tokens.IssueAccess(session.UserID, session.ID, now)
	if err != nil {
		return TokenPair{}, err
	}

	return TokenPair{
		AccessToken:      access,
		AccessExpiresAt:  expiresAt,
		RefreshToken:     refreshToken,
		RefreshExpiresAt: session.ExpiresAt,
	}, nil
}

// fingerprint marks the current credentials of the user. The hash itself never
// reaches the token: a JWT payload is readable by anyone holding it.
func (s *Service) fingerprint(authHash string) string {
	mac := hmac.New(sha256.New, s.fingerprintKey)
	mac.Write([]byte(authHash))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil)[:fingerprintLength])
}

func (s *Service) decoySalt(login string) []byte {
	mac := hmac.New(sha256.New, s.preloginKey)
	mac.Write([]byte(strings.ToLower(strings.TrimSpace(login))))

	return mac.Sum(nil)[:preloginSaltLength]
}
