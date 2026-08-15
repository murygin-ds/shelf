package access

import (
	"time"

	"shelf/internal/access"
	"shelf/internal/vault"
)

type sealedKeyRequest struct {
	ScopeID    int64  `binding:"required,min=1"          json:"scope_id"`
	KeyVersion int32  `binding:"required,min=1"          json:"key_version"`
	WrappedKey []byte `binding:"required,min=32,max=2048" json:"wrapped_key" format:"byte"`
	Nonce      []byte `binding:"required,min=12,max=32"   json:"nonce"       format:"byte"`
	// Algorithm names the wrapping format. Invite keys use a code-derived symmetric key
	// rather than a sealed box, because nobody knows yet whose key to seal to.
	Algorithm string `binding:"omitempty,max=64" json:"wrap_algorithm,omitempty"`
}

func sealedKeys(in []sealedKeyRequest) []access.SealedKey {
	out := make([]access.SealedKey, 0, len(in))

	for _, key := range in {
		out = append(out, access.SealedKey{
			ScopeID:    key.ScopeID,
			KeyVersion: key.KeyVersion,
			WrappedKey: key.WrappedKey,
			Nonce:      key.Nonce,
			Algorithm:  key.Algorithm,
		})
	}

	return out
}

type setRoleRequest struct {
	Role string `binding:"required,oneof=admin editor viewer" json:"role"`
}

type putGrantRequest struct {
	ScopeType   string `binding:"required,oneof=folder file"                json:"scope_type"`
	ScopeRefID  int64  `binding:"required,min=1"                            json:"scope_ref_id"`
	SubjectType string `binding:"required,oneof=user group"                 json:"subject_type"`
	SubjectID   int64  `binding:"required,min=1"                            json:"subject_id"`
	Permission  string `binding:"required,oneof=none view comment edit own" json:"permission"`
	// Keys must cover the node's scope whenever the permission allows reading: without
	// them the subject would see an entry it can never open.
	Keys []sealedKeyRequest `binding:"omitempty,max=64,dive" json:"key_grants"`
}

type createInviteRequest struct {
	// TokenHash is the digest of a code the server never sees. Exactly one of this and
	// TargetUserID is set.
	TokenHash    []byte `binding:"omitempty,len=32"   json:"token_hash,omitempty"    format:"byte"`
	TargetUserID *int64 `binding:"omitempty,min=1"    json:"target_user_id,omitempty"`
	EmailHint    string `binding:"omitempty,max=128"  json:"email_hint,omitempty"`
	Role         string `binding:"required,oneof=admin editor viewer" json:"role"`
	// Preview holds the vault name and the inviter, encrypted under the same code, so an
	// unauthenticated lookup reveals nothing.
	Preview      []byte             `binding:"omitempty,min=16,max=2048" json:"wrapped_preview,omitempty" format:"byte"`
	PreviewNonce []byte             `binding:"omitempty,min=12,max=32"   json:"preview_nonce,omitempty"   format:"byte"`
	ExpiresAt    *time.Time         `json:"expires_at,omitempty"`
	Keys         []sealedKeyRequest `binding:"required,min=1,max=64,dive" json:"key_grants"`
}

type lookupInviteRequest struct {
	TokenHash []byte `binding:"required,len=32" json:"token_hash" format:"byte"`
}

type redeemInviteRequest struct {
	TokenHash []byte             `binding:"omitempty,len=32"           json:"token_hash,omitempty" format:"byte"`
	InviteID  int64              `binding:"omitempty,min=1"            json:"invite_id,omitempty"`
	Keys      []sealedKeyRequest `binding:"required,min=1,max=64,dive" json:"key_grants"`
}

// MemberResponse is one row of the member table.
type MemberResponse struct {
	UserID      int64      `json:"user_id"      example:"7"`
	Login       string     `json:"login"        example:"marta@acme.dev"`
	DisplayName string     `json:"display_name" example:"Marta Chen"`
	PublicKey   []byte     `json:"public_key"   format:"byte"`
	Fingerprint string     `json:"fingerprint"  example:"A1B2 C3D4 E5F6 G7H8"`
	Role        string     `json:"role"         example:"editor"`
	KeyState    string     `json:"key_state"    example:"ok"`
	FolderCount int        `json:"folder_count" example:"3"`
	LastActive  *time.Time `json:"last_active"`
	CreatedAt   time.Time  `json:"created_at"`
}

type MembersResponse struct {
	Members []MemberResponse `json:"members"`
}

// DirectoryResponse is what a lookup by login reveals: enough to seal a key to someone,
// and the fingerprint to check that the key really is theirs.
type DirectoryResponse struct {
	UserID      int64  `json:"user_id"      example:"7"`
	Login       string `json:"login"        example:"marta@acme.dev"`
	DisplayName string `json:"display_name" example:"Marta Chen"`
	PublicKey   []byte `json:"public_key"   format:"byte"`
	Fingerprint string `json:"fingerprint"  example:"A1B2 C3D4 E5F6 G7H8"`
}

type GrantResponse struct {
	ID           int64     `json:"id"            example:"3"`
	ScopeType    string    `json:"scope_type"    example:"folder"`
	ScopeRefID   int64     `json:"scope_ref_id"  example:"12"`
	SubjectType  string    `json:"subject_type"  example:"user"`
	SubjectID    int64     `json:"subject_id"    example:"7"`
	SubjectLabel string    `json:"subject_label" example:"Marta Chen"`
	Permission   string    `json:"permission"    example:"edit"`
	CreatedAt    time.Time `json:"created_at"`
}

type GrantsResponse struct {
	Grants []GrantResponse `json:"grants"`
}

// RemovalResponse reports what still has to happen for the revocation to be retroactive.
// Deleting the key grants protects everything written from now on; it cannot un-read what
// was already read, and only rotating those scopes closes that.
type RemovalResponse struct {
	PendingRotation []int64 `json:"pending_rotation"`
}

type InviteResponse struct {
	ID          int64      `json:"id"           example:"4"`
	VaultID     int64      `json:"vault_id"     example:"1"`
	Role        string     `json:"role"         example:"editor"`
	EmailHint   string     `json:"email_hint"   example:"dana@acme.dev"`
	InviterName string     `json:"inviter_name" example:"Ilya Volkov"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RedeemedAt  *time.Time `json:"redeemed_at"`
	CreatedAt   time.Time  `json:"created_at"`
}

type InvitesResponse struct {
	Invites []InviteResponse `json:"invites"`
}

// ChallengeResponse is everything an unauthenticated lookup returns: ciphertext and an
// expiry. The vault name lives inside the preview, encrypted under the code.
type ChallengeResponse struct {
	InviteID     int64               `json:"invite_id"       example:"4"`
	Preview      []byte              `json:"wrapped_preview" format:"byte"`
	PreviewNonce []byte              `json:"preview_nonce"   format:"byte"`
	Keys         []SealedKeyResponse `json:"key_grants"`
	ExpiresAt    time.Time           `json:"expires_at"`
}

type SealedKeyResponse struct {
	ScopeID    int64  `json:"scope_id"       example:"1"`
	KeyVersion int32  `json:"key_version"    example:"1"`
	WrappedKey []byte `json:"wrapped_key"    format:"byte"`
	Nonce      []byte `json:"nonce"          format:"byte"`
	Algorithm  string `json:"wrap_algorithm" example:"aesgcm-invite-v1"`
}

func members(list []access.Member) MembersResponse {
	out := make([]MemberResponse, 0, len(list))

	for _, m := range list {
		out = append(out, MemberResponse{
			UserID:      m.UserID,
			Login:       m.Login,
			DisplayName: m.DisplayName,
			PublicKey:   m.PublicKey,
			Fingerprint: m.Fingerprint,
			Role:        string(m.Role),
			KeyState:    string(m.KeyState),
			FolderCount: m.FolderCount,
			LastActive:  m.LastActive,
			CreatedAt:   m.CreatedAt,
		})
	}

	return MembersResponse{Members: out}
}

func directory(found *access.Directory) DirectoryResponse {
	return DirectoryResponse{
		UserID:      found.UserID,
		Login:       found.Login,
		DisplayName: found.DisplayName,
		PublicKey:   found.PublicKey,
		Fingerprint: found.Fingerprint,
	}
}

func grantResponse(g *access.Grant) GrantResponse {
	return GrantResponse{
		ID:           g.ID,
		ScopeType:    string(g.ScopeType),
		ScopeRefID:   g.ScopeRefID,
		SubjectType:  string(g.Subject.Type),
		SubjectID:    g.Subject.ID,
		SubjectLabel: g.SubjectLabel,
		Permission:   string(g.Permission),
		CreatedAt:    g.CreatedAt,
	}
}

func grants(list []access.Grant) GrantsResponse {
	out := make([]GrantResponse, 0, len(list))

	for i := range list {
		out = append(out, grantResponse(&list[i]))
	}

	return GrantsResponse{Grants: out}
}

func inviteResponse(in *access.Invite) InviteResponse {
	return InviteResponse{
		ID:          in.ID,
		VaultID:     in.VaultID,
		Role:        string(in.Role),
		EmailHint:   in.EmailHint,
		InviterName: in.InviterName,
		ExpiresAt:   in.ExpiresAt,
		RedeemedAt:  in.RedeemedAt,
		CreatedAt:   in.CreatedAt,
	}
}

func invites(list []access.Invite) InvitesResponse {
	out := make([]InviteResponse, 0, len(list))

	for i := range list {
		out = append(out, inviteResponse(&list[i]))
	}

	return InvitesResponse{Invites: out}
}

func challenge(found *access.Challenge) ChallengeResponse {
	keys := make([]SealedKeyResponse, 0, len(found.Keys))

	for _, key := range found.Keys {
		keys = append(keys, SealedKeyResponse{
			ScopeID:    key.ScopeID,
			KeyVersion: key.KeyVersion,
			WrappedKey: key.WrappedKey,
			Nonce:      key.Nonce,
			Algorithm:  key.Algorithm,
		})
	}

	return ChallengeResponse{
		InviteID:     found.InviteID,
		Preview:      found.Preview.Ciphertext,
		PreviewNonce: found.Preview.Nonce,
		Keys:         keys,
		ExpiresAt:    found.ExpiresAt,
	}
}

func scopeType(value string) vault.ScopeType { return vault.ScopeType(value) }
