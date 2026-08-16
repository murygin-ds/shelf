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
	ScopeID       int64  `json:"scope_id"        example:"1"`
	ScopeClientID string `json:"scope_client_id"`
	KeyVersion    int32  `json:"key_version"    example:"1"`
	WrappedKey    []byte `json:"wrapped_key"    format:"byte"`
	Nonce         []byte `json:"nonce"          format:"byte"`
	Algorithm     string `json:"wrap_algorithm" example:"aesgcm-invite-v1"`
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
			ScopeID:       key.ScopeID,
			ScopeClientID: key.ScopeClientID,
			KeyVersion:    key.KeyVersion,
			WrappedKey:    key.WrappedKey,
			Nonce:         key.Nonce,
			Algorithm:     key.Algorithm,
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

// -- groups ------------------------------------------------------------------

type sealedGroupKeyRequest struct {
	UserID     int64  `binding:"required,min=1"           json:"user_id"`
	WrappedKey []byte `binding:"required,min=32,max=4096" json:"wrapped_key" format:"byte"`
	Nonce      []byte `binding:"required,min=12,max=32"   json:"nonce"       format:"byte"`
}

type createGroupRequest struct {
	ClientID  string `binding:"required,uuid"            json:"client_id"`
	Meta      []byte `binding:"required,min=16,max=8192" json:"meta"       format:"byte"`
	MetaNonce []byte `binding:"required,min=12,max=32"   json:"meta_nonce" format:"byte"`
	// PublicKey is the group's raw P-256 agreement key. A group never writes, so it needs
	// no signing key — there would be nothing to attribute.
	PublicKey []byte `binding:"required,len=65" json:"public_key" format:"byte"`
	// Members must include the caller: the private key exists only in these copies, and a
	// group its own manager cannot open is a group nobody can ever add to.
	Members []sealedGroupKeyRequest `binding:"required,min=1,max=200,dive" json:"members"`
}

type updateGroupRequest struct {
	Meta      []byte `binding:"required,min=16,max=8192" json:"meta"       format:"byte"`
	MetaNonce []byte `binding:"required,min=12,max=32"   json:"meta_nonce" format:"byte"`
}

type setGroupMembersRequest struct {
	Members []sealedGroupKeyRequest `binding:"required,min=1,max=200,dive" json:"members"`
	// PublicKey and Keys are required when somebody is being dropped: the copy they hold
	// opens every scope the group reaches, and deleting rows on the server does not take
	// that back.
	PublicKey []byte             `binding:"omitempty,len=65"           json:"public_key,omitempty" format:"byte"`
	Keys      []sealedKeyRequest `binding:"omitempty,max=256,dive"     json:"key_grants,omitempty"`
}

type GroupMemberResponse struct {
	UserID      int64  `json:"user_id"      example:"7"`
	Login       string `json:"login"        example:"marta@acme.dev"`
	DisplayName string `json:"display_name" example:"Marta Chen"`
	Fingerprint string `json:"fingerprint"  example:"A1B2 C3D4 E5F6 G7H8"`
	KeyVersion  int32  `json:"key_version"  example:"1"`
}

type GroupResponse struct {
	ID         int64                 `json:"id"          example:"3"`
	ClientID   string                `json:"client_id"`
	VaultID    int64                 `json:"vault_id"    example:"12"`
	Meta       []byte                `json:"meta"        format:"byte"`
	MetaNonce  []byte                `json:"meta_nonce"  format:"byte"`
	PublicKey  []byte                `json:"public_key"  format:"byte"`
	KeyVersion int32                 `json:"key_version" example:"1"`
	Members    []GroupMemberResponse `json:"members"`
	CreatedBy  *int64                `json:"created_by,omitempty"`
	CreatedAt  time.Time             `json:"created_at"`
}

type GroupsResponse struct {
	Groups []GroupResponse `json:"groups"`
}

// GroupKeyResponse is the caller's own copy of a group's private key. It is useless to
// anybody else: it is sealed to the public key of the person asking.
type GroupKeyResponse struct {
	GroupID       int64  `json:"group_id"        example:"3"`
	GroupClientID string `json:"group_client_id"`
	KeyVersion    int32  `json:"key_version"     example:"1"`
	WrappedKey    []byte `json:"wrapped_key"     format:"byte"`
	Nonce         []byte `json:"nonce"           format:"byte"`
}

type GroupKeysResponse struct {
	Keys []GroupKeyResponse `json:"keys"`
}

func groupResponse(group *access.Group) GroupResponse {
	members := make([]GroupMemberResponse, 0, len(group.Members))

	for _, member := range group.Members {
		members = append(members, GroupMemberResponse{
			UserID:      member.UserID,
			Login:       member.Login,
			DisplayName: member.DisplayName,
			Fingerprint: member.Fingerprint,
			KeyVersion:  member.KeyVersion,
		})
	}

	return GroupResponse{
		ID:         group.ID,
		ClientID:   group.ClientID,
		VaultID:    group.VaultID,
		Meta:       group.Meta.Ciphertext,
		MetaNonce:  group.Meta.Nonce,
		PublicKey:  group.PublicKey,
		KeyVersion: group.KeyVersion,
		Members:    members,
		CreatedBy:  group.CreatedBy,
		CreatedAt:  group.CreatedAt,
	}
}

func groupsResponse(groups []access.Group) GroupsResponse {
	out := GroupsResponse{Groups: make([]GroupResponse, 0, len(groups))}

	for i := range groups {
		out.Groups = append(out.Groups, groupResponse(&groups[i]))
	}

	return out
}

func groupKeysResponse(keys []access.GroupKey) GroupKeysResponse {
	out := GroupKeysResponse{Keys: make([]GroupKeyResponse, 0, len(keys))}

	for _, key := range keys {
		out.Keys = append(out.Keys, GroupKeyResponse{
			GroupID:       key.GroupID,
			GroupClientID: key.GroupClientID,
			KeyVersion:    key.KeyVersion,
			WrappedKey:    key.WrappedKey,
			Nonce:         key.Nonce,
		})
	}

	return out
}

func groupMembers(in []sealedGroupKeyRequest) []access.SealedGroupKey {
	out := make([]access.SealedGroupKey, 0, len(in))

	for _, member := range in {
		out = append(out, access.SealedGroupKey{
			UserID:     member.UserID,
			WrappedKey: member.WrappedKey,
			Nonce:      member.Nonce,
		})
	}

	return out
}
