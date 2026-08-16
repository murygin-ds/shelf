package access

import (
	"context"
	"time"

	"shelf/internal/vault"
)

// MaxGroupMembers bounds one membership write. A group is a way to name a handful of
// people, not a second copy of the member list.
const MaxGroupMembers = 200

// Group is a named set of people that can hold a permission.
//
// It carries its own ECDH keypair, and that is the whole reason it exists. Without one,
// "add Marta to Design" would require the person doing it to hold every content key the
// group can reach — so an admin excluded from one folder could not add anybody to a group
// that touches it. Instead a scope key is sealed to the group once, and the group's private
// key is sealed to each member: adding somebody is one seal, whatever the group can reach.
//
// The cost lands on removal, which needs a new keypair and every scope key sealed again.
// That is the right way round: joining is common, leaving is not.
type Group struct {
	ID       int64
	ClientID string
	VaultID  int64
	Meta     vault.Blob
	// PublicKey is the group's raw P-256 agreement key. A group never writes, so it has no
	// signing key: there would be nothing to attribute.
	PublicKey  []byte
	KeyVersion int32
	Members    []GroupMember
	CreatedBy  *int64
	CreatedAt  time.Time
}

// GroupMember is one person's copy of the group's private key.
type GroupMember struct {
	UserID      int64
	Login       string
	DisplayName string
	Fingerprint string
	KeyVersion  int32
	// WrappedKey is the group's private key sealed to this member's public key.
	WrappedKey []byte
	Nonce      []byte
}

// GroupScope is one key a group holds: which scope, and at which version.
type GroupScope struct {
	ScopeID       int64
	ScopeClientID string
	KeyVersion    int32
}

// GroupKey is what a member needs to open anything sealed to a group they belong to.
type GroupKey struct {
	GroupID       int64
	GroupClientID string
	KeyVersion    int32
	WrappedKey    []byte
	Nonce         []byte
}

// NewGroup creates a group. The client generates the keypair and seals the private half to
// every founding member, itself included.
type NewGroup struct {
	VaultID    int64
	ClientID   string
	Meta       vault.Blob
	PublicKey  []byte
	KeyVersion int32
	Members    []SealedGroupKey
}

// SealedGroupKey is the group's private key sealed to one person.
type SealedGroupKey struct {
	UserID     int64
	WrappedKey []byte
	Nonce      []byte
}

// GroupMembership replaces a group's members.
//
// Removing somebody means the group's key has to change: the person leaving already holds
// the old one, and every scope sealed to the group would still open for them. So a write
// that drops a member must carry a new keypair and every scope key sealed again to it,
// exactly like a re-key — which is what it is.
type GroupMembership struct {
	GroupID int64
	Members []SealedGroupKey
	// PublicKey and KeyVersion are set only when the keypair is being replaced.
	PublicKey  []byte
	KeyVersion int32
	// Keys re-seal the group's scope grants to the new keypair.
	Keys []SealedKey
}

// Rotates reports whether this write replaces the group's keypair.
func (g GroupMembership) Rotates() bool { return len(g.PublicKey) > 0 }

// GroupRepository stores groups and their membership.
type GroupRepository interface {
	Groups(ctx context.Context, vaultID int64) ([]Group, error)
	Group(ctx context.Context, groupID int64) (*Group, error)
	CreateGroup(ctx context.Context, in NewGroup, actorID int64) (*Group, error)
	UpdateGroupMeta(ctx context.Context, groupID int64, meta vault.Blob) error
	DeleteGroup(ctx context.Context, groupID, actorID int64) error
	// SetGroupMembers replaces the membership, and when the keypair changes writes the new
	// public key and the re-sealed scope grants in the same transaction.
	SetGroupMembers(ctx context.Context, in GroupMembership, actorID int64) (*Group, error)
	// GroupKeys returns the caller's copy of the private key of every group they belong to.
	GroupKeys(ctx context.Context, vaultID, userID int64) ([]GroupKey, error)
	// GroupScopes lists every scope key the group holds, version by version. A rotation has
	// to re-seal all of them, and only the server knows the full set.
	GroupScopes(ctx context.Context, groupID int64) ([]GroupScope, error)
}

func (s *Service) Groups(ctx context.Context, actorID, vaultID int64) ([]Group, error) {
	if _, err := s.member(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	groups, err := s.groups.Groups(ctx, vaultID)
	if err != nil {
		return nil, translate(err, "list groups")
	}

	return groups, nil
}

// CreateGroup opens a group. Only somebody who manages the vault may, and they have to be
// among the founding members: the private key is generated on their device, and a group
// nobody can open is a group nobody can ever add to.
func (s *Service) CreateGroup(ctx context.Context, actorID int64, in NewGroup) (*Group, error) {
	if _, err := s.manager(ctx, in.VaultID, actorID); err != nil {
		return nil, err
	}

	if len(in.Members) == 0 || len(in.Members) > MaxGroupMembers {
		return nil, ErrGroupMembers
	}

	if !holds(in.Members, actorID) {
		return nil, ErrGroupKeyless
	}

	created, err := s.groups.CreateGroup(ctx, in, actorID)
	if err != nil {
		return nil, translate(err, "create group")
	}

	return created, nil
}

func (s *Service) UpdateGroup(ctx context.Context, actorID, groupID int64, meta vault.Blob) error {
	if _, err := s.groupFor(ctx, actorID, groupID); err != nil {
		return err
	}

	if err := s.groups.UpdateGroupMeta(ctx, groupID, meta); err != nil {
		return translate(err, "update group")
	}

	return nil
}

// DeleteGroup disbands a group. Its permission grants go with it, so anybody who reached a
// folder only through it loses that reach — which is the point, and why it takes a manager.
func (s *Service) DeleteGroup(ctx context.Context, actorID, groupID int64) error {
	if _, err := s.groupFor(ctx, actorID, groupID); err != nil {
		return err
	}

	if err := s.groups.DeleteGroup(ctx, groupID, actorID); err != nil {
		return translate(err, "delete group")
	}

	return nil
}

// SetGroupMembers replaces who is in a group.
//
// Dropping somebody requires a new keypair: the copy they already hold opens every scope
// the group can reach, and no server-side deletion takes that back. The caller has to bring
// the re-sealed scope keys with them, because only somebody holding the old group key could
// have produced them.
func (s *Service) SetGroupMembers(ctx context.Context, actorID int64, in GroupMembership) (*Group, error) {
	group, err := s.groupFor(ctx, actorID, in.GroupID)
	if err != nil {
		return nil, err
	}

	if len(in.Members) == 0 || len(in.Members) > MaxGroupMembers {
		return nil, ErrGroupMembers
	}

	if !holds(in.Members, actorID) {
		return nil, ErrGroupKeyless
	}

	if removes(group.Members, in.Members) && !in.Rotates() {
		return nil, ErrGroupRotation
	}

	if in.Rotates() {
		in.KeyVersion = group.KeyVersion + 1
	}

	updated, err := s.groups.SetGroupMembers(ctx, in, actorID)
	if err != nil {
		return nil, translate(err, "set group members")
	}

	return updated, nil
}

// GroupKeys hands the caller their copy of the private key of every group they are in.
// Without it the group-sealed scope keys in their keyring are bytes they cannot open.
// GroupScopes tells a client what a rotation of this group will have to re-seal.
func (s *Service) GroupScopes(ctx context.Context, actorID, groupID int64) ([]GroupScope, error) {
	if _, err := s.groupFor(ctx, actorID, groupID); err != nil {
		return nil, err
	}

	scopes, err := s.groups.GroupScopes(ctx, groupID)
	if err != nil {
		return nil, translate(err, "read group scopes")
	}

	return scopes, nil
}

func (s *Service) GroupKeys(ctx context.Context, actorID, vaultID int64) ([]GroupKey, error) {
	if _, err := s.member(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	keys, err := s.groups.GroupKeys(ctx, vaultID, actorID)
	if err != nil {
		return nil, translate(err, "read group keys")
	}

	return keys, nil
}

// groupFor resolves a group the caller may manage. A group in a vault they cannot see
// answers the same way one that does not exist does.
func (s *Service) groupFor(ctx context.Context, actorID, groupID int64) (*Group, error) {
	group, err := s.groups.Group(ctx, groupID)
	if err != nil {
		return nil, translate(err, "read group")
	}

	if _, err := s.manager(ctx, group.VaultID, actorID); err != nil {
		return nil, err
	}

	return group, nil
}

func holds(members []SealedGroupKey, userID int64) bool {
	for _, member := range members {
		if member.UserID == userID {
			return true
		}
	}

	return false
}

// removes reports whether anybody in the old membership is absent from the new one.
func removes(before []GroupMember, after []SealedGroupKey) bool {
	keeping := make(map[int64]bool, len(after))

	for _, member := range after {
		keeping[member.UserID] = true
	}

	for _, member := range before {
		if !keeping[member.UserID] {
			return true
		}
	}

	return false
}
