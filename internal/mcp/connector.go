package mcp

import (
	"context"
	"errors"
	"time"

	"shelf/internal/vault"
)

// The errors the API turns into status codes. A vault nobody may see reports ErrNotFound
// rather than a refusal, on the same terms as everything else here.
var (
	ErrNotFound = errors.New("no connector on this vault")
	ErrExists   = errors.New("this vault already has a connector")
	ErrDisabled = errors.New("the connector is turned off on this server")
)

// Connector is a vault this server has been handed a key to.
//
// It is an account and a membership, not a category of its own: everything that resolves
// permissions, rotates keys or lists members treats it as one more subject, which is what
// keeps this feature from growing a second copy of any of those.
type Connector struct {
	VaultID     int64
	UserID      int64
	Login       string
	PublicKey   []byte
	Fingerprint string
	Role        vault.Role
	// KeyState is pending_key between the two halves of enabling: the member exists but has
	// not been handed the scope key yet, and until it is the connector reads nothing.
	KeyState  vault.KeyState
	CreatedAt time.Time
}

// Admitted reports whether the connector has been handed the key it was created for.
func (c Connector) Admitted() bool { return c.KeyState == vault.KeyStateOK }

// NewConnector is what the enabling transaction writes.
type NewConnector struct {
	VaultID   int64
	EnabledBy int64
	Role      vault.Role
	Account   Account
}

// SealedKey is a scope key sealed to the connector's public half by the browser.
type SealedKey struct {
	ScopeID    int64
	KeyVersion int32
	WrappedKey []byte
	Nonce      []byte
	Algorithm  string
}

// Repository is the storage the connector service drives.
type Repository interface {
	// Create writes the account, the membership and the connector row together. It is
	// idempotent: a vault that already has a connector gets its existing one back, because
	// the browser may have to ask for the public key more than once before it seals to it.
	Create(ctx context.Context, in NewConnector) (*Connector, error)
	// Admit records the sealed scope keys and marks the membership ready, in the one
	// transaction that justifies writing a key grant.
	Admit(ctx context.Context, vaultID, actorID int64, keys []SealedKey) (*Connector, error)
	// Connector reads the row, and Keys the wrapped halves needed to open it.
	Connector(ctx context.Context, vaultID int64) (*Connector, error)
	Keys(ctx context.Context, vaultID int64) (StoredKeys, error)
	// Grants are the connector's key grants, in the form the keyring opens.
	Grants(ctx context.Context, vaultID int64) ([]vault.KeyGrant, error)
}
