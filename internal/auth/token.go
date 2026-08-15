package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"time"

	"shelf/internal/config"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// ErrInvalidToken is returned for a malformed, expired or foreign token.
var ErrInvalidToken = errors.New("invalid token")

const refreshTokenBytes = 32

// Token scopes: a recovery token must not work as an access token and vice versa.
const (
	scopeAccess   = "access"
	scopeRecovery = "recovery"
)

// Claims is the payload of the issued JWTs.
type Claims struct {
	jwt.RegisteredClaims
	// SessionID ties an access token to a session, so that a revoked session does not
	// outlive the token issued for it beyond its TTL. It is 0 for a recovery token.
	SessionID int64 `json:"sid,omitempty"`
	// Scope restricts what the token may be used for.
	Scope string `json:"scp"`
	// Fingerprint binds a recovery token to the credentials that were in effect when it
	// was issued. A JWT payload is readable by anyone, so this is an HMAC of the hash, not the hash itself.
	Fingerprint string `json:"fpr,omitempty"`
}

// UserID returns the user identifier from the sub claim.
func (c Claims) UserID() (int64, error) {
	id, err := strconv.ParseInt(c.Subject, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: bad subject", ErrInvalidToken)
	}

	return id, nil
}

// TokenPair is the token pair handed to the client.
type TokenPair struct {
	AccessToken      string
	AccessExpiresAt  time.Time
	RefreshToken     string
	RefreshExpiresAt time.Time
}

// TokenManager issues and parses tokens.
type TokenManager struct {
	secret      []byte
	issuer      string
	accessTTL   time.Duration
	refreshTTL  time.Duration
	recoveryTTL time.Duration
}

// NewTokenManager creates the token manager from the configuration.
func NewTokenManager(cfg config.Auth) *TokenManager {
	return &TokenManager{
		secret:      []byte(cfg.Secret),
		issuer:      cfg.Issuer,
		accessTTL:   cfg.AccessTTL,
		refreshTTL:  cfg.RefreshTTL,
		recoveryTTL: cfg.RecoveryTTL,
	}
}

// RefreshTTL returns the lifetime of a refresh token.
func (m *TokenManager) RefreshTTL() time.Duration { return m.refreshTTL }

// IssueAccess signs an access token for a user/session pair.
func (m *TokenManager) IssueAccess(userID, sessionID int64, now time.Time) (string, time.Time, error) {
	claims := m.claims(userID, scopeAccess, m.accessTTL, now)
	claims.SessionID = sessionID

	return m.sign(claims)
}

// IssueRecovery signs a short-lived token proving ownership of the recovery code:
// the client completes the access recovery with it.
// fingerprint makes the token single-use — it stops matching as soon as the
// credentials change.
func (m *TokenManager) IssueRecovery(userID int64, fingerprint string, now time.Time) (string, time.Time, error) {
	claims := m.claims(userID, scopeRecovery, m.recoveryTTL, now)
	claims.Fingerprint = fingerprint

	return m.sign(claims)
}

// ParseAccess validates the signature, the expiry and the scope of an access token.
func (m *TokenManager) ParseAccess(token string) (*Claims, error) {
	return m.parse(token, scopeAccess)
}

// ParseRecovery validates the signature, the expiry and the scope of a recovery token.
func (m *TokenManager) ParseRecovery(token string) (*Claims, error) {
	return m.parse(token, scopeRecovery)
}

func (m *TokenManager) claims(userID int64, scope string, ttl time.Duration, now time.Time) Claims {
	return Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    m.issuer,
			Subject:   strconv.FormatInt(userID, 10),
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
		Scope: scope,
	}
}

func (m *TokenManager) sign(claims Claims) (string, time.Time, error) {
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign %s token: %w", claims.Scope, err)
	}

	return signed, claims.ExpiresAt.Time, nil
}

func (m *TokenManager) parse(token, scope string) (*Claims, error) {
	claims := &Claims{}

	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("%w: unexpected signing method %v", ErrInvalidToken, t.Header["alg"])
		}

		return m.secret, nil
	},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(m.issuer),
		jwt.WithExpirationRequired(),
	)
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrInvalidToken, err)
	}

	if !parsed.Valid {
		return nil, ErrInvalidToken
	}

	if claims.Scope != scope {
		return nil, fmt.Errorf("%w: scope %q is not %q", ErrInvalidToken, claims.Scope, scope)
	}

	return claims, nil
}

// NewRefreshToken generates a random refresh token: only its hash reaches the database.
func NewRefreshToken() (string, error) {
	buf := make([]byte, refreshTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate refresh token: %w", err)
	}

	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashRefreshToken computes the sha256 of a refresh token.
// The token is random and full-length, so a slow KDF is not needed here.
func HashRefreshToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
