package access

import (
	"context"
	"errors"
	"fmt"
	"time"

	"shelf/internal/vault"

	"go.uber.org/zap"
)

// Nodes resolves what a caller may do to one node and which key its content sits under.
type Nodes interface {
	FolderRef(ctx context.Context, folderID, userID int64) (*vault.Ref, error)
	FileRef(ctx context.Context, fileID, userID int64) (*vault.Ref, error)
}

type Deps struct {
	Repo   Repository
	Nodes  Nodes
	Logger *zap.Logger
}

type Service struct {
	repo  Repository
	nodes Nodes
	log   *zap.Logger
}

func NewService(deps Deps) *Service {
	return &Service{repo: deps.Repo, nodes: deps.Nodes, log: deps.Logger}
}

// MaxInviteTTL bounds how long an admission can stay open.
const MaxInviteTTL = 30 * 24 * time.Hour

func (s *Service) Members(ctx context.Context, userID, vaultID int64) ([]Member, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	members, err := s.repo.Members(ctx, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read members: %w", err)
	}

	return members, nil
}

// Lookup finds an account to seal a key to. It answers for any authenticated caller, so it
// deliberately returns nothing beyond what sealing needs — an account either exists under
// that address or it does not, which the sign-up form already reveals.
func (s *Service) Lookup(ctx context.Context, login string) (*Directory, error) {
	found, err := s.repo.Lookup(ctx, login)
	if err != nil {
		return nil, translate(err, "look up account")
	}

	return found, nil
}

// SetRole changes what a member may do across the whole vault.
func (s *Service) SetRole(ctx context.Context, actorID, vaultID, targetID int64, role vault.Role) error {
	actor, err := s.manager(ctx, vaultID, actorID)
	if err != nil {
		return err
	}

	if !role.Valid() || role == vault.RoleOwner {
		return ErrForbidden
	}

	target, err := s.repo.Membership(ctx, vaultID, targetID)
	if err != nil {
		return translate(err, "read membership")
	}

	// The owner is the account the vault belongs to. Handing that over is a separate act
	// from managing access, and an admin must not be able to perform it sideways.
	if target.Role == vault.RoleOwner {
		return ErrOwnerRequired
	}

	if actor.UserID == targetID {
		return ErrSelfTarget
	}

	if err := s.repo.SetRole(ctx, vaultID, targetID, role); err != nil {
		return fmt.Errorf("set role: %w", err)
	}

	return nil
}

// RemoveMember revokes access immediately and reports the scopes that now need rotating.
//
// Revocation and rotation are different promises. Deleting the key grants stops the server
// from ever handing those keys out again, which protects everything written from now on.
// It cannot un-read what was already read, nor reach into a copy the member already has —
// only rotating the keys and re-encrypting does that, and it is queued, not instant.
func (s *Service) RemoveMember(ctx context.Context, actorID, vaultID, targetID int64) ([]int64, error) {
	if _, err := s.manager(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	target, err := s.repo.Membership(ctx, vaultID, targetID)
	if err != nil {
		return nil, translate(err, "read membership")
	}

	if target.Role == vault.RoleOwner {
		return nil, ErrOwnerRequired
	}

	if actorID == targetID {
		return nil, ErrSelfTarget
	}

	scopes, err := s.repo.RemoveMember(ctx, vaultID, targetID)
	if err != nil {
		return nil, fmt.Errorf("remove member: %w", err)
	}

	s.log.Info("member removed, scopes await rotation",
		zap.Int64("vault_id", vaultID),
		zap.Int64("user_id", targetID),
		zap.Int("scopes", len(scopes)),
	)

	return scopes, nil
}

func (s *Service) Grants(
	ctx context.Context,
	userID, vaultID int64,
	scopeType vault.ScopeType,
	scopeRefID int64,
) ([]Grant, error) {
	if _, err := s.node(ctx, userID, scopeType, scopeRefID, vault.PermView); err != nil {
		return nil, err
	}

	grants, err := s.repo.Grants(ctx, vaultID, scopeType, scopeRefID)
	if err != nil {
		return nil, fmt.Errorf("read grants: %w", err)
	}

	return grants, nil
}

// PutGrant sets one subject's permission on one node.
//
// Widening must arrive with the scope key sealed to that subject, or the subject would see
// a node in their tree they can never open. Narrowing needs no key — but it is only
// server-enforced until the node owns its own key scope, because everyone who already
// holds the enclosing key still holds it.
func (s *Service) PutGrant(ctx context.Context, actorID int64, in GrantInput) (*Grant, error) {
	ref, err := s.node(ctx, actorID, in.ScopeType, in.ScopeRefID, vault.PermOwn)
	if err != nil {
		return nil, err
	}

	if ref.VaultID != in.VaultID {
		return nil, ErrNotFound
	}

	if in.Permission.Allowed() && !coversScope(in.Keys, ref.KeyScopeID, ref.KeyVersion) {
		return nil, ErrKeysRequired
	}

	if !in.Permission.Allowed() {
		in.Keys = nil
	}

	granted, err := s.repo.PutGrant(ctx, in, actorID)
	if err != nil {
		return nil, translate(err, "write grant")
	}

	return granted, nil
}

func (s *Service) DeleteGrant(ctx context.Context, actorID, vaultID, grantID int64) error {
	if _, err := s.manager(ctx, vaultID, actorID); err != nil {
		return err
	}

	if err := s.repo.DeleteGrant(ctx, vaultID, grantID); err != nil {
		return translate(err, "delete grant")
	}

	return nil
}

func (s *Service) CreateInvite(ctx context.Context, actorID int64, in NewInvite) (*Invite, error) {
	if _, err := s.manager(ctx, in.VaultID, actorID); err != nil {
		return nil, err
	}

	if !in.Role.Valid() || in.Role == vault.RoleOwner {
		return nil, ErrForbidden
	}

	if len(in.Keys) == 0 {
		return nil, ErrKeysRequired
	}

	now := time.Now()
	if in.ExpiresAt.IsZero() || in.ExpiresAt.After(now.Add(MaxInviteTTL)) {
		in.ExpiresAt = now.Add(MaxInviteTTL)
	}

	if !in.ExpiresAt.After(now) {
		return nil, ErrInviteInvalid
	}

	in.InvitedBy = actorID

	created, err := s.repo.CreateInvite(ctx, in)
	if err != nil {
		return nil, translate(err, "create invite")
	}

	return created, nil
}

func (s *Service) Invites(ctx context.Context, actorID, vaultID int64) ([]Invite, error) {
	if _, err := s.manager(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	invites, err := s.repo.Invites(ctx, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read invites: %w", err)
	}

	return invites, nil
}

func (s *Service) MyInvites(ctx context.Context, userID int64) ([]Invite, error) {
	invites, err := s.repo.InvitesFor(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("read invites: %w", err)
	}

	return invites, nil
}

func (s *Service) RevokeInvite(ctx context.Context, actorID, vaultID, inviteID int64) error {
	if _, err := s.manager(ctx, vaultID, actorID); err != nil {
		return err
	}

	if err := s.repo.RevokeInvite(ctx, vaultID, inviteID); err != nil {
		return translate(err, "revoke invite")
	}

	return nil
}

// Challenge resolves an invite for whoever is holding the code. Every failure answers the
// same way: distinguishing "expired" from "already used" from "never existed" would make
// the endpoint a probe for valid codes.
func (s *Service) Challenge(ctx context.Context, tokenHash []byte) (*Challenge, error) {
	found, err := s.repo.ChallengeByToken(ctx, tokenHash)
	if err != nil {
		return nil, translate(err, "read invite")
	}

	return found, nil
}

func (s *Service) InviteForMe(ctx context.Context, userID, inviteID int64) (*Challenge, error) {
	found, err := s.repo.ChallengeForUser(ctx, inviteID, userID)
	if err != nil {
		return nil, translate(err, "read invite")
	}

	return found, nil
}

// Redeem admits the caller. The keys arriving here were opened with the code and re-sealed
// to the caller's own public key, so the invite's copies can be dropped in the same
// transaction: an invite that has been used must stop being a way in.
func (s *Service) Redeem(ctx context.Context, userID int64, in Redemption) (*Invite, error) {
	if len(in.Keys) == 0 {
		return nil, ErrKeysRequired
	}

	redeemed, err := s.repo.Redeem(ctx, in, userID)
	if err != nil {
		return nil, translate(err, "redeem invite")
	}

	return redeemed, nil
}

func (s *Service) member(ctx context.Context, vaultID, userID int64) (*vault.Membership, error) {
	found, err := s.repo.Membership(ctx, vaultID, userID)
	if err != nil {
		return nil, translate(err, "read membership")
	}

	return found, nil
}

func (s *Service) manager(ctx context.Context, vaultID, userID int64) (*vault.Membership, error) {
	found, err := s.member(ctx, vaultID, userID)
	if err != nil {
		return nil, err
	}

	if !found.Role.Manages() {
		return nil, ErrForbidden
	}

	return found, nil
}

func (s *Service) node(
	ctx context.Context,
	userID int64,
	scopeType vault.ScopeType,
	scopeRefID int64,
	min vault.Permission,
) (*vault.Ref, error) {
	var (
		ref *vault.Ref
		err error
	)

	switch scopeType {
	case vault.ScopeFolder:
		ref, err = s.nodes.FolderRef(ctx, scopeRefID, userID)
	case vault.ScopeFile:
		ref, err = s.nodes.FileRef(ctx, scopeRefID, userID)
	default:
		return nil, ErrNotFound
	}

	if err != nil {
		return nil, translate(err, "read node")
	}

	if !ref.Permission.AtLeast(min) {
		return nil, ErrForbidden
	}

	return ref, nil
}

func coversScope(keys []SealedKey, scopeID int64, version int32) bool {
	for _, key := range keys {
		if key.ScopeID == scopeID && key.KeyVersion == version {
			return true
		}
	}

	return false
}

func translate(err error, op string) error {
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, vault.ErrNotFound):
		return ErrNotFound
	case errors.Is(err, ErrForbidden), errors.Is(err, vault.ErrForbidden):
		return ErrForbidden
	case errors.Is(err, ErrInviteInvalid),
		errors.Is(err, ErrAlreadyMember),
		errors.Is(err, ErrKeysRequired),
		errors.Is(err, ErrOwnerRequired),
		errors.Is(err, ErrSelfTarget):
		return err
	default:
		return fmt.Errorf("%s: %w", op, err)
	}
}
