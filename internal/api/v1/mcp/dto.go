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

// credentialRequest names a credential so the list is readable later.
type credentialRequest struct {
	Label string `binding:"omitempty,max=120" example:"laptop" json:"label"`
}

// IssuedResponse carries a credential in the clear. It is the only time it exists that way:
// what the database keeps is a digest, so a lost credential is replaced rather than recovered.
type IssuedResponse struct {
	Secret    string    `json:"secret"     example:"3Yy2...redacted"`
	Kind      string    `json:"kind"       example:"static"`
	Label     string    `json:"label"      example:"laptop"`
	ExpiresAt time.Time `json:"expires_at"`
}

// CredentialResponse describes an outstanding credential without being one.
type CredentialResponse struct {
	ID         int64      `json:"id"           example:"3"`
	Kind       string     `json:"kind"         example:"static"`
	Label      string     `json:"label"        example:"laptop"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	ExpiresAt  time.Time  `json:"expires_at"`
}

// CredentialsResponse is the list.
type CredentialsResponse struct {
	Credentials []CredentialResponse `json:"credentials"`
}

func credentialsResponse(list []mcp.TokenSummary) CredentialsResponse {
	out := CredentialsResponse{Credentials: make([]CredentialResponse, 0, len(list))}

	for _, item := range list {
		out.Credentials = append(out.Credentials, CredentialResponse{
			ID:         item.ID,
			Kind:       item.Kind,
			Label:      item.Label,
			CreatedAt:  item.CreatedAt,
			LastUsedAt: item.LastUsedAt,
			ExpiresAt:  item.ExpiresAt,
		})
	}

	return out
}

func roleOf(raw string) vault.Role { return vault.Role(raw) }

// registerRequest is RFC 7591 client metadata. Only what is used is read; the rest of what a
// client sends is ignored rather than refused.
type registerRequest struct {
	ClientName   string   `binding:"omitempty,max=200"        json:"client_name"`
	RedirectURIs []string `binding:"required,min=1,max=16,dive,url" json:"redirect_uris"`
}

// registerResponse is the registration, echoed as the RFC shapes it.
type registerResponse struct {
	ClientID                string   `json:"client_id"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	ClientName              string   `json:"client_name,omitempty"`
	RedirectURIs            []string `json:"redirect_uris"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
}

// clientResponse is what the consent screen shows about who is asking.
type clientResponse struct {
	ClientID     string   `json:"client_id"`
	ClientName   string   `json:"client_name"`
	RedirectURIs []string `json:"redirect_uris"`
}

// approveRequest is what the consent screen posts once the person agrees.
type approveRequest struct {
	VaultID       int64  `binding:"required,min=1"    json:"vault_id"`
	ClientID      string `binding:"required,max=200"  json:"client_id"`
	RedirectURI   string `binding:"required,url"      json:"redirect_uri"`
	CodeChallenge string `binding:"required,max=200"  json:"code_challenge"`
	State         string `binding:"omitempty,max=500" json:"state"`
}

// approveResponse is where to send the browser next.
type approveResponse struct {
	RedirectTo string `json:"redirect_to"`
}

// tokenResponse is RFC 6749 §5.1.
type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	RefreshToken string `json:"refresh_token,omitempty"`
	Scope        string `json:"scope,omitempty"`
}
