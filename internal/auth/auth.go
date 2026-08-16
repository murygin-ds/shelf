// Package auth implements registration, login and session management.
//
// The scheme is end-to-end: the user password and master key are unknown to the server.
// From the password the client derives two values using kdf_salt/kdf_params:
// the master key wrapping key (stays on the client) and auth_hash (goes to the server).
// The server stores an Argon2id hash of auth_hash and the wrapped keys, which it
// hands back to the client after a successful login.
package auth

import (
	"context"
	"errors"
	"net/netip"
	"time"
)

// Business logic errors. The HTTP layer translates them into response codes.
var (
	ErrLoginTaken         = errors.New("login already taken")
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrUserNotFound       = errors.New("user not found")
	ErrSessionNotFound    = errors.New("session not found")
	// ErrSessionReused means a refresh token was presented again after rotation:
	// a sign of token theft, so all sessions of the user are revoked.
	ErrSessionReused = errors.New("refresh token reused")
)

// KDFAlgorithmArgon2id is the only supported client-side KDF.
const KDFAlgorithmArgon2id = "argon2id"

// KDFParams holds the client-side KDF parameters. The server does not apply them,
// it stores them and returns them to the client so it can reproduce the key derivation.
type KDFParams struct {
	Algorithm   string `json:"algorithm"`
	Memory      uint32 `json:"memory"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
}

// DefaultKDFParams are the parameters the server suggests to new clients and
// puts into the prelogin response for logins that do not exist.
func DefaultKDFParams() KDFParams {
	return KDFParams{
		Algorithm:   KDFAlgorithmArgon2id,
		Memory:      64 * 1024,
		Iterations:  3,
		Parallelism: 2,
	}
}

// KeyBundle is the cryptographic material of the user. Everything is encrypted client-side.
type KeyBundle struct {
	KDFSalt           []byte
	KDFParams         KDFParams
	WrappedMasterKey  []byte
	MasterKeyNonce    []byte
	PublicKey         []byte
	WrappedPrivateKey []byte
	PrivateKeyNonce   []byte
}

// RecoveryKey is the stored recovery key: the wrapped master key and the code verifier.
type RecoveryKey struct {
	UserID int64
	// VerifierHash is the server-side hash of recovery_auth_hash, filled in by the service.
	VerifierHash     string
	WrappedMasterKey []byte
	Nonce            []byte
}

// NewRecoveryKey is the recovery key in the form the client sends it.
// AuthHash is derived from the recovery code separately from the wrapping key,
// so the master key cannot be unwrapped with it.
type NewRecoveryKey struct {
	AuthHash         []byte
	WrappedMasterKey []byte
	Nonce            []byte
}

// User is an account together with its wrapped keys.
type User struct {
	ID    int64
	Login string
	// DisplayName is the name other members see
	DisplayName string
	AuthHash    string
	Keys        KeyBundle
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Session is an issued refresh token along with the device metadata.
type Session struct {
	ID         int64
	UserID     int64
	UserAgent  string
	IP         netip.Addr
	ExpiresAt  time.Time
	RevokedAt  *time.Time
	CreatedAt  time.Time
	LastUsedAt time.Time
}

// NewUser is the data required to create an account. The hashes are already computed by the service.
type NewUser struct {
	Login       string
	DisplayName string
	AuthHash    string
	Keys        KeyBundle
	Recovery    RecoveryKey
}

// RegisterInput is the registration data in the form the client sent it.
type RegisterInput struct {
	Login       string
	DisplayName string
	AuthHash    []byte
	Keys        KeyBundle
	Recovery    NewRecoveryKey
}

// NewSession is the data required to create a session.
type NewSession struct {
	UserID    int64
	TokenHash []byte
	UserAgent string
	IP        netip.Addr
	ExpiresAt time.Time
}

// Credentials is the new set of authentication data used on a password change or
// an access recovery. The public/private key pair does not change: the private key
// is wrapped with the master key, and the master key stays the same.
type Credentials struct {
	// AuthHash is the server-side hash of the new auth_hash, filled in by the service.
	AuthHash         string
	KDFSalt          []byte
	KDFParams        KDFParams
	WrappedMasterKey []byte
	MasterKeyNonce   []byte
	// Recovery is filled in if the client rotates the recovery code.
	Recovery *RecoveryKey
}

// CredentialsInput is the new authentication data in the form the client sent it.
type CredentialsInput struct {
	AuthHash         []byte
	KDFSalt          []byte
	KDFParams        KDFParams
	WrappedMasterKey []byte
	MasterKeyNonce   []byte
	Recovery         *NewRecoveryKey
}

// ClientMeta describes the calling client for the session log.
type ClientMeta struct {
	UserAgent string
	IP        netip.Addr
}

// Repository is the access layer for the account and session storage.
type Repository interface {
	CreateUser(ctx context.Context, in NewUser) (*User, error)
	UserByLogin(ctx context.Context, login string) (*User, error)
	UserByID(ctx context.Context, id int64) (*User, error)
	// ResetCredentials atomically replaces the authentication data, rotates the
	// recovery key when needed and revokes all sessions of the user.
	ResetCredentials(ctx context.Context, userID int64, in Credentials) error
	RecoveryKeyByLogin(ctx context.Context, login string) (*RecoveryKey, error)

	CreateSession(ctx context.Context, in NewSession) (*Session, error)
	SessionByTokenHash(ctx context.Context, tokenHash []byte) (*Session, error)
	// RotateSession revokes the old session and creates a new one in a single transaction.
	RotateSession(ctx context.Context, oldID int64, in NewSession) (*Session, error)
	RevokeSessionByTokenHash(ctx context.Context, tokenHash []byte) error
	RevokeSession(ctx context.Context, userID, sessionID int64) error
	RevokeUserSessions(ctx context.Context, userID int64) error
	ListSessions(ctx context.Context, userID int64) ([]Session, error)
}
