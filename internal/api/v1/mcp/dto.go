package mcp

import (
	"time"

	"shelf/internal/mcp"
	"shelf/internal/vault"
)

// enableRequest asks for a connector identity. The role is the ceiling on what Claude can
// do with the vault, and it is deliberately not the caller's role.
type enableRequest struct {
	Role string `binding:"required,oneof=editor viewer" example:"editor" json:"role"`
}

// admitRequest carries the scope keys the browser sealed to the connector's public half.
// The server cannot check what is inside them; the bounds are on the shape alone.
type admitRequest struct {
	Keys []sealedKeyRequest `binding:"required,min=1,max=64,dive" json:"keys"`
}

type sealedKeyRequest struct {
	ScopeID    int64  `binding:"required,min=1"          json:"scope_id"`
	KeyVersion int32  `binding:"required,min=1"          json:"key_version"`
	WrappedKey []byte `binding:"required,min=32,max=1024" format:"byte" json:"wrapped_key"`
	Nonce      []byte `binding:"required,min=12,max=32"   format:"byte" json:"nonce"`
	Algorithm  string `binding:"omitempty,max=64"        json:"wrap_algorithm,omitempty"`
}

func (r admitRequest) keys() []mcp.SealedKey {
	keys := make([]mcp.SealedKey, 0, len(r.Keys))

	for _, key := range r.Keys {
		keys = append(keys, mcp.SealedKey{
			ScopeID:    key.ScopeID,
			KeyVersion: key.KeyVersion,
			WrappedKey: key.WrappedKey,
			Nonce:      key.Nonce,
			Algorithm:  key.Algorithm,
		})
	}

	return keys
}

// ConnectorResponse describes the connector on a vault.
type ConnectorResponse struct {
	VaultID int64 `json:"vault_id" example:"1"`
	// UserID is the connector's account. It is a real member, so it appears in the member
	// list and in the rotation plan like anybody else.
	UserID int64 `json:"user_id"    example:"42"`
	// PublicKey is the identity blob the browser seals scope keys to.
	PublicKey []byte `format:"byte" json:"public_key"`
	// Fingerprint is what a person compares against the one the server logged at startup.
	Fingerprint string `json:"fingerprint" example:"0XXE EW2H S7R6 V26W"`
	Role        string `json:"role"        example:"editor"`
	KeyState    string `json:"key_state"   example:"ok"`
	// Ready is false between the two halves of enabling: the member exists and reads nothing.
	Ready     bool      `json:"ready"      example:"true"`
	CreatedAt time.Time `json:"created_at"`
}

func connectorResponse(c *mcp.Connector) ConnectorResponse {
	return ConnectorResponse{
		VaultID:     c.VaultID,
		UserID:      c.UserID,
		PublicKey:   c.PublicKey,
		Fingerprint: c.Fingerprint,
		Role:        string(c.Role),
		KeyState:    string(c.KeyState),
		Ready:       c.Admitted(),
		CreatedAt:   c.CreatedAt,
	}
}

// DisabledResponse names the scopes the removed connector could read.
//
// Revocation is immediate, but a key it already copied stays valid for the ciphertext it
// already saw. Rotating these is what makes the removal retroactive, and the client is told
// so it can offer that rather than leave it to be remembered.
type DisabledResponse struct {
	ScopesAwaitingRotation []int64 `json:"scopes_awaiting_rotation"`
}

func roleOf(raw string) vault.Role { return vault.Role(raw) }
