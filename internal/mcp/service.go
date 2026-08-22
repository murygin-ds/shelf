package mcp

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/config"
	"shelf/internal/vault"

	"go.uber.org/zap"
)

var (
	// ErrOwnerRequired guards the one decision nobody but the owner should make.
	ErrOwnerRequired = errors.New("only the owner may connect a vault")
	// ErrRoleInvalid rejects a connector that would manage people rather than notes.
	ErrRoleInvalid = errors.New("a connector may be an editor or a viewer")
)

// Members reads a caller's standing in a vault. Narrow on purpose: this service decides one
// thing about permissions and has no business reaching further.
type Members interface {
	Membership(ctx context.Context, vaultID, userID int64) (*vault.Membership, error)
}

// Remover is the member removal already written for people, which is the whole of turning a
// connector off: the connector row hangs off the membership by a foreign key, so it goes in
// the same transaction, and the scopes it could read come back marked for rotation.
type Remover interface {
	RemoveMember(ctx context.Context, vaultID, userID, actorID int64) ([]int64, error)
}

// Deps are the service's dependencies.
type Deps struct {
	Repo    Repository
	Tokens  Tokens
	OAuth   OAuth
	Members Members
	Remover Remover
	Vaults  Vaults
	// Live is optional: with the socket off there is no session to collide with, and a
	// nil one means every write goes ahead.
	Live   Live
	Hasher Hasher
	Config config.MCP
	Logger *zap.Logger
}

// Service turns a vault into one this server holds a key to, and back again.
type Service struct {
	repo    Repository
	tokens  Tokens
	oauth   OAuth
	members Members
	remover Remover
	vaults  Vaults
	live    Live
	hasher  Hasher
	cfg     config.MCP
	log     *zap.Logger
}

// NewService creates the service.
func NewService(deps Deps) *Service {
	return &Service{
		repo:    deps.Repo,
		tokens:  deps.Tokens,
		oauth:   deps.OAuth,
		members: deps.Members,
		remover: deps.Remover,
		vaults:  deps.Vaults,
		live:    deps.Live,
		hasher:  deps.Hasher,
		cfg:     deps.Config,
		log:     deps.Logger,
	}
}

// Enable mints the connector's identity and admits it to the vault without a key.
//
// It is deliberately half of the act. The browser cannot seal a scope key to a public key
// that does not exist yet, so this returns one and waits: until Admit follows, the connector
// is a member that reads nothing.
func (s *Service) Enable(ctx context.Context, actorID, vaultID int64, role vault.Role) (*Connector, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	// Owner and admin can change who else gets in. A connector is a reader and a writer of
	// notes, never a manager of people.
	if role != vault.RoleEditor && role != vault.RoleViewer {
		return nil, ErrRoleInvalid
	}

	account, err := NewAccount(s.cfg.Secret, s.hasher)
	if err != nil {
		return nil, err
	}

	connector, err := s.repo.Create(ctx, NewConnector{
		VaultID:   vaultID,
		EnabledBy: actorID,
		Role:      role,
		Account:   *account,
	})
	if err != nil {
		return nil, err
	}

	s.log.Info("connector created, waiting for its key",
		zap.Int64("vault_id", vaultID),
		zap.Int64("connector_id", connector.UserID),
		zap.String("fingerprint", connector.Fingerprint),
	)

	return connector, nil
}

// Admit records the scope keys the browser sealed to the connector. From here the server can
// read what the connector's membership allows, and not a row more.
func (s *Service) Admit(ctx context.Context, actorID, vaultID int64, keys []SealedKey) (*Connector, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	connector, err := s.repo.Admit(ctx, vaultID, actorID, keys)
	if err != nil {
		return nil, err
	}

	s.log.Warn("a connector now holds this vault's key",
		zap.Int64("vault_id", vaultID),
		zap.Int64("connector_id", connector.UserID),
		zap.String("fingerprint", connector.Fingerprint),
		zap.Int("scopes", len(keys)),
	)

	return connector, nil
}

// Disable removes the connector. Revocation is immediate; the scopes it returns are the ones
// that stay readable to whoever already copied the key, which is what rotation is for.
func (s *Service) Disable(ctx context.Context, actorID, vaultID int64) ([]int64, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	connector, err := s.repo.Connector(ctx, vaultID)
	if err != nil {
		return nil, err
	}

	scopes, err := s.remover.RemoveMember(ctx, vaultID, connector.UserID, actorID)
	if err != nil {
		return nil, fmt.Errorf("remove the connector: %w", err)
	}

	s.log.Info("connector removed, scopes await rotation",
		zap.Int64("vault_id", vaultID),
		zap.Int64("connector_id", connector.UserID),
		zap.Int("scopes", len(scopes)),
	)

	return scopes, nil
}

// Status reports the connector to somebody who can see the vault.
func (s *Service) Status(ctx context.Context, actorID, vaultID int64) (*Connector, error) {
	if _, err := s.membership(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	return s.repo.Connector(ctx, vaultID)
}

// Keyring opens the scope keys the connector holds.
//
// Read per call rather than cached: a connector removed a moment ago must stop reading a
// moment ago, and a rotation that moved a scope to a new version must be picked up without
// anything having to remember to invalidate.
func (s *Service) Keyring(ctx context.Context, vaultID int64) (*Keyring, error) {
	keys, err := s.repo.Keys(ctx, vaultID)
	if err != nil {
		return nil, err
	}

	identity, err := OpenIdentity(s.cfg.Secret, keys)
	if err != nil {
		return nil, err
	}

	grants, err := s.repo.Grants(ctx, vaultID)
	if err != nil {
		return nil, err
	}

	return NewKeyring(identity, grants), nil
}

// Workspace opens the connected vault for one request.
//
// Everything it needs is read fresh: the connector row, its wrapped keys, its grants. That
// is what makes revocation and rotation take effect on the next call rather than the next
// restart, and it is cheap next to decrypting the notes the call is about to touch.
func (s *Service) Workspace(ctx context.Context, connector *Connector) (*Workspace, error) {
	ring, err := s.Keyring(ctx, connector.VaultID)
	if err != nil {
		return nil, err
	}

	keys, err := s.repo.Keys(ctx, connector.VaultID)
	if err != nil {
		return nil, err
	}

	identity, err := OpenIdentity(s.cfg.Secret, keys)
	if err != nil {
		return nil, err
	}

	return Open(ctx, s.vaults, s.live, ring, identity, connector)
}

// owner is the guard on every change to a connector. Admitting a reader of a vault is one
// thing; handing the server its key is the owner's decision and nobody else's.
func (s *Service) owner(ctx context.Context, vaultID, actorID int64) error {
	membership, err := s.membership(ctx, vaultID, actorID)
	if err != nil {
		return err
	}

	if membership.Role != vault.RoleOwner {
		return ErrOwnerRequired
	}

	return nil
}

// membership doubles as the visibility check: somebody who is not a member is told the vault
// does not exist rather than that they may not touch it.
func (s *Service) membership(ctx context.Context, vaultID, actorID int64) (*vault.Membership, error) {
	membership, err := s.members.Membership(ctx, vaultID, actorID)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("read membership: %w", err)
	}

	return membership, nil
}
