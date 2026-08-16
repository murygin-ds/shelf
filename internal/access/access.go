// Package access implements membership, permission grants and invites.
//
// One rule shapes everything here: a key grant is never written on its own. It lands in
// the same transaction as the permission that justifies it, because a key that outlives
// its permission is a standing backdoor the server can no longer see.
package access

import (
	"context"
	"errors"
	"time"

	"shelf/internal/vault"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrForbidden = errors.New("forbidden")
	// ErrInviteInvalid covers every reason an invite will not redeem. They are one error
	// on purpose: telling them apart turns the lookup into an oracle.
	ErrInviteInvalid = errors.New("invite is not valid")
	ErrAlreadyMember = errors.New("already a member of this vault")
	// ErrKeysRequired means a widening change arrived without the keys that make it real.
	ErrKeysRequired  = errors.New("the change needs the scope keys sealed to the subject")
	ErrOwnerRequired = errors.New("a vault must keep its owner")
	ErrSelfTarget    = errors.New("a member cannot apply this to themselves")
	// ErrGroupMembers means the membership list was empty or longer than a group should be.
	ErrGroupMembers = errors.New("a group must hold between 1 and 200 members")
	// ErrGroupKeyless means the caller left themselves out. The group's private key lives
	// only in the copies sealed to its members, so a group its manager cannot open is a
	// group nobody can ever add to.
	ErrGroupKeyless = errors.New("whoever writes a group's membership must be in it")
	// ErrGroupRotation means somebody was dropped without a new keypair. The copy they hold
	// opens every scope the group reaches, and no deletion on the server takes that back.
	ErrGroupRotation = errors.New("removing a member requires a new group key")
	// ErrGroupScopes means a rotation arrived without a key for every scope the group
	// already holds. Applying it would leave the group with permissions on folders whose
	// keys it no longer has — visible rows nobody in it can open.
	ErrGroupScopes = errors.New("a group rotation must re-seal every scope the group holds")
)

// Member is a row of the design's member table.
type Member struct {
	UserID      int64
	Login       string
	DisplayName string
	PublicKey   []byte
	// Fingerprint is a short digest of PublicKey. The server hands out public keys, so it
	// could hand out its own; comparing fingerprints out of band is what closes that.
	Fingerprint string
	Role        vault.Role
	KeyState    vault.KeyState
	FolderCount int
	LastActive  *time.Time
	InvitedBy   *int64
	CreatedAt   time.Time
}

// Directory is what a lookup by login reveals: enough to seal a key to someone, and
// nothing else about them.
type Directory struct {
	UserID      int64
	Login       string
	DisplayName string
	PublicKey   []byte
	Fingerprint string
}

// Grant is an explicit permission on one node.
type Grant struct {
	ID         int64
	VaultID    int64
	ScopeType  vault.ScopeType
	ScopeRefID int64
	Subject    vault.Subject
	Permission vault.Permission
	// SubjectLabel is the login or group name, filled in for display only.
	SubjectLabel string
	CreatedBy    *int64
	CreatedAt    time.Time
}

// SealedKey is a scope key sealed to a subject, travelling alongside the grant it serves.
type SealedKey struct {
	ScopeID int64
	// ScopeClientID names the scope inside the seal, so a redeemer can re-seal the key to
	// themselves in a form the keyring will open.
	ScopeClientID string
	KeyVersion    int32
	WrappedKey    []byte
	Nonce         []byte
	Algorithm     string
}

// GrantInput sets or replaces one subject's permission on one node.
type GrantInput struct {
	VaultID    int64
	ScopeType  vault.ScopeType
	ScopeRefID int64
	Subject    vault.Subject
	Permission vault.Permission
	// Keys must cover every scope the subject gains the ability to read. Widening without
	// them would produce an entry in the tree the subject can see but never open.
	Keys []SealedKey
}

// Invite is a pending admission to a vault.
type Invite struct {
	ID          int64
	VaultID     int64
	Role        vault.Role
	EmailHint   string
	TargetUser  *int64
	InvitedBy   *int64
	InviterName string
	ExpiresAt   time.Time
	RedeemedAt  *time.Time
	RevokedAt   *time.Time
	CreatedAt   time.Time
}

// NewInvite creates an admission. Exactly one of TokenHash and TargetUserID is set: a code
// invite carries the hash of a secret the server never sees, a direct invite names an
// account whose public key the keys were already sealed to.
type NewInvite struct {
	VaultID    int64
	TokenHash  []byte
	TargetUser *int64
	EmailHint  string
	Role       vault.Role
	// Preview holds the vault name and the inviter, encrypted under a key derived from the
	// same secret, so an unauthenticated lookup reveals nothing.
	Preview   vault.Blob
	InvitedBy int64
	ExpiresAt time.Time
	Keys      []SealedKey
}

// Challenge is what an unauthenticated lookup by code returns: ciphertext and nothing else.
type Challenge struct {
	InviteID  int64
	Preview   vault.Blob
	Keys      []SealedKey
	ExpiresAt time.Time
}

// Redemption turns an invite into a membership. The client has already opened the invite's
// keys with the code and re-sealed them to its own public key.
type Redemption struct {
	TokenHash []byte
	InviteID  int64
	Keys      []SealedKey
}

// Repository is the storage the access service drives.
type Repository interface {
	Members(ctx context.Context, vaultID int64) ([]Member, error)
	Membership(ctx context.Context, vaultID, userID int64) (*vault.Membership, error)
	SetRole(ctx context.Context, vaultID, userID int64, role vault.Role, actorID int64) error
	// RemoveMember deletes the membership, every permission grant and every key grant the
	// member held at any version, and marks the scopes they could read as needing a
	// rotation. Revocation is immediate; rotation is what makes it retroactive.
	RemoveMember(ctx context.Context, vaultID, userID, actorID int64) ([]int64, error)

	Lookup(ctx context.Context, login string) (*Directory, error)
	PublicKey(ctx context.Context, userID int64) ([]byte, error)

	Grants(ctx context.Context, vaultID int64, scopeType vault.ScopeType, scopeRefID int64) ([]Grant, error)
	// PutGrant writes the permission and the sealed keys in one transaction.
	PutGrant(ctx context.Context, in GrantInput, actorID int64) (*Grant, error)
	DeleteGrant(ctx context.Context, vaultID, grantID, actorID int64) error

	CreateInvite(ctx context.Context, in NewInvite) (*Invite, error)
	Invites(ctx context.Context, vaultID int64) ([]Invite, error)
	InvitesFor(ctx context.Context, userID int64) ([]Invite, error)
	RevokeInvite(ctx context.Context, vaultID, inviteID, actorID int64) error
	// ChallengeByToken resolves a code invite for an anonymous caller.
	ChallengeByToken(ctx context.Context, tokenHash []byte) (*Challenge, error)
	ChallengeForUser(ctx context.Context, inviteID, userID int64) (*Challenge, error)
	// Redeem admits the caller and rewrites the invite's key grants as their own, in one
	// transaction, so a half-redeemed invite cannot leave keys addressed to a secret that
	// has already been used.
	Redeem(ctx context.Context, in Redemption, userID int64) (*Invite, error)
}
