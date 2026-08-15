package vault

import (
	"context"
	"errors"
	"fmt"

	"go.uber.org/zap"
)

// Deps are the storage the service orchestrates.
type Deps struct {
	Vaults  Repository
	Folders FolderRepository
	Files   FileRepository
	Tree    TreeRepository
	Sync    SyncRepository
	Rekeys  RekeyRepository
	Audit   AuditRepository
	Logger  *zap.Logger
}

// Service enforces authorization and the key-scope invariants. It holds no SQL and no
// HTTP: every decision here is one a reader can check against the access model.
type Service struct {
	vaults  Repository
	folders FolderRepository
	files   FileRepository
	tree    TreeRepository
	sync    SyncRepository
	rekeys  RekeyRepository
	audit   AuditRepository
	log     *zap.Logger
}

func NewService(deps Deps) *Service {
	return &Service{
		vaults:  deps.Vaults,
		folders: deps.Folders,
		files:   deps.Files,
		tree:    deps.Tree,
		sync:    deps.Sync,
		rekeys:  deps.Rekeys,
		audit:   deps.Audit,
		log:     deps.Logger,
	}
}

// CreateVault opens a workspace. The vault, its key scope, the owner membership and the
// owner's key grant are written together: a key grant that outlives its permission would
// be a backdoor, and a membership without a key would be an account that cannot read.
func (s *Service) CreateVault(
	ctx context.Context,
	ownerID int64,
	clientID, scopeClientID string,
	meta Blob,
	key SealedKey,
) (*Vault, error) {
	if key.Algorithm == "" {
		key.Algorithm = DefaultWrapAlgorithm
	}

	created, err := s.vaults.CreateVault(ctx,
		NewVault{ClientID: clientID, ScopeClientID: scopeClientID, OwnerID: ownerID, Meta: meta, Key: key})
	if err != nil {
		return nil, fmt.Errorf("create vault: %w", err)
	}

	return created, nil
}

func (s *Service) Vaults(ctx context.Context, userID int64) ([]Summary, error) {
	summaries, err := s.vaults.VaultsByMember(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list vaults: %w", err)
	}

	return summaries, nil
}

func (s *Service) Vault(ctx context.Context, userID, vaultID int64) (*Vault, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	found, err := s.vaults.Vault(ctx, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read vault: %w", err)
	}

	return found, nil
}

func (s *Service) UpdateVault(ctx context.Context, userID, vaultID int64, meta Blob) error {
	member, err := s.member(ctx, vaultID, userID)
	if err != nil {
		return err
	}

	if !member.Role.Manages() {
		return ErrForbidden
	}

	if err := s.vaults.UpdateVaultMeta(ctx, vaultID, meta); err != nil {
		return fmt.Errorf("update vault: %w", err)
	}

	return nil
}

// DeleteVault is the owner's alone: an admin can manage access, but destroying the
// ciphertext of everyone else is a different kind of act.
func (s *Service) DeleteVault(ctx context.Context, userID, vaultID int64) error {
	member, err := s.member(ctx, vaultID, userID)
	if err != nil {
		return err
	}

	if member.Role != RoleOwner {
		return ErrForbidden
	}

	if err := s.vaults.DeleteVault(ctx, vaultID); err != nil {
		return fmt.Errorf("delete vault: %w", err)
	}

	return nil
}

// Keys bootstraps the caller's keyring in one round trip: every grant they can open,
// across every scope and every version, including the versions that only old revisions
// and trashed items are still encrypted under.
func (s *Service) Keys(ctx context.Context, userID, vaultID int64) ([]KeyGrant, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	grants, err := s.vaults.KeyGrants(ctx, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("read key grants: %w", err)
	}

	return grants, nil
}

func (s *Service) Scopes(ctx context.Context, userID, vaultID int64) ([]ScopeStatus, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	scopes, err := s.vaults.Scopes(ctx, vaultID)
	if err != nil {
		return nil, fmt.Errorf("read key scopes: %w", err)
	}

	return scopes, nil
}

// Tree returns everything in the vault the caller may see. Nodes they cannot decrypt are
// absent rather than empty: the permission query filters them out server-side.
func (s *Service) Tree(ctx context.Context, userID, vaultID int64) ([]Folder, []File, error) {
	return s.readTree(ctx, userID, vaultID, false)
}

func (s *Service) Trash(ctx context.Context, userID, vaultID int64) ([]Folder, []File, error) {
	return s.readTree(ctx, userID, vaultID, true)
}

func (s *Service) readTree(ctx context.Context, userID, vaultID int64, deleted bool) ([]Folder, []File, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, nil, err
	}

	folders, files, err := s.tree.Tree(ctx, vaultID, userID, deleted)
	if err != nil {
		return nil, nil, fmt.Errorf("read tree: %w", err)
	}

	return folders, files, nil
}

func (s *Service) CreateFolder(ctx context.Context, userID int64, in NewFolder) (*Folder, error) {
	parent, err := s.destination(ctx, userID, in.VaultID, in.ParentID)
	if err != nil {
		return nil, err
	}

	if err := s.matchesScope(parent, in.KeyScopeID, in.KeyVersion); err != nil {
		return nil, err
	}

	created, err := s.folders.CreateFolder(ctx, in, userID)
	if err != nil {
		return nil, fmt.Errorf("create folder: %w", err)
	}

	return created, nil
}

func (s *Service) UpdateFolder(ctx context.Context, userID, folderID int64, in MetaUpdate) (*Folder, error) {
	if _, err := s.folderFor(ctx, userID, folderID, PermEdit); err != nil {
		return nil, err
	}

	updated, err := s.folders.UpdateFolderMeta(ctx, folderID, in, userID)
	if err != nil {
		return nil, fmt.Errorf("update folder: %w", err)
	}

	return updated, nil
}

// MoveFolder relocates a subtree. Three things can go wrong and all of them are refused
// rather than repaired: a cycle, a tree deeper than the resolution query will walk, and a
// destination whose key scope differs from the subtree's, which would leave the moved
// ciphertext unreadable to everyone at the destination.
func (s *Service) MoveFolder(ctx context.Context, userID, folderID int64, in Move) (*Folder, error) {
	source, err := s.folderFor(ctx, userID, folderID, PermEdit)
	if err != nil {
		return nil, err
	}

	if in.ParentID != nil && *in.ParentID == folderID {
		return nil, ErrCycle
	}

	destination, err := s.destination(ctx, userID, source.VaultID, in.ParentID)
	if err != nil {
		return nil, err
	}

	if in.ParentID != nil {
		descendant, err := s.folders.IsDescendant(ctx, *in.ParentID, folderID)
		if err != nil {
			return nil, fmt.Errorf("check folder ancestry: %w", err)
		}

		if descendant {
			return nil, ErrCycle
		}
	}

	if err := s.matchesScope(destination, source.KeyScopeID, source.KeyVersion); err != nil {
		return nil, err
	}

	moved, err := s.folders.MoveFolder(ctx, folderID, in, userID)
	if err != nil {
		return nil, fmt.Errorf("move folder: %w", err)
	}

	return moved, nil
}

func (s *Service) DeleteFolder(ctx context.Context, userID, folderID int64) error {
	return s.setFolderDeleted(ctx, userID, folderID, true)
}

func (s *Service) RestoreFolder(ctx context.Context, userID, folderID int64) error {
	return s.setFolderDeleted(ctx, userID, folderID, false)
}

func (s *Service) setFolderDeleted(ctx context.Context, userID, folderID int64, deleted bool) error {
	if _, err := s.folderFor(ctx, userID, folderID, PermEdit); err != nil {
		return err
	}

	if err := s.folders.SetFolderDeleted(ctx, folderID, deleted, userID); err != nil {
		return fmt.Errorf("set folder deleted: %w", err)
	}

	return nil
}

// PurgeFolder destroys ciphertext for good, so it asks for the strongest permission.
func (s *Service) PurgeFolder(ctx context.Context, userID, folderID int64) error {
	if _, err := s.folderFor(ctx, userID, folderID, PermOwn); err != nil {
		return err
	}

	if err := s.folders.PurgeFolder(ctx, folderID); err != nil {
		return fmt.Errorf("purge folder: %w", err)
	}

	return nil
}

func (s *Service) CreateFile(ctx context.Context, userID int64, in NewFile) (*File, error) {
	parent, err := s.destination(ctx, userID, in.VaultID, in.FolderID)
	if err != nil {
		return nil, err
	}

	if err := s.matchesScope(parent, in.KeyScopeID, in.KeyVersion); err != nil {
		return nil, err
	}

	created, err := s.files.CreateFile(ctx, in, userID)
	if err != nil {
		return nil, fmt.Errorf("create file: %w", err)
	}

	return created, nil
}

func (s *Service) File(ctx context.Context, userID, fileID int64) (*File, error) {
	found, err := s.files.File(ctx, fileID, userID)
	if err != nil {
		return nil, translate(err, "read file")
	}

	return found, nil
}

// Files is the hydration path behind the local search index, so it is bounded by the
// caller's permissions and by the page size the handler enforces.
func (s *Service) Files(ctx context.Context, userID, vaultID int64, ids []int64) ([]File, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	files, err := s.files.Files(ctx, vaultID, userID, ids)
	if err != nil {
		return nil, fmt.Errorf("read files: %w", err)
	}

	return files, nil
}

func (s *Service) UpdateFile(ctx context.Context, userID, fileID int64, in MetaUpdate) (*File, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermEdit); err != nil {
		return nil, err
	}

	updated, err := s.files.UpdateFileMeta(ctx, fileID, in, userID)
	if err != nil {
		return nil, fmt.Errorf("update file: %w", err)
	}

	return updated, nil
}

// UpdateContent writes a note body under an optimistic lock. A stale sequence is a
// conflict the client has to resolve, because only the client can read either version.
func (s *Service) UpdateContent(ctx context.Context, userID, fileID int64, in ContentUpdate) (*File, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermEdit); err != nil {
		return nil, err
	}

	updated, err := s.files.UpdateFileContent(ctx, fileID, in, userID)
	if err != nil {
		return nil, translate(err, "update file content")
	}

	return updated, nil
}

func (s *Service) MoveFile(ctx context.Context, userID, fileID int64, in Move) (*File, error) {
	source, err := s.fileFor(ctx, userID, fileID, PermEdit)
	if err != nil {
		return nil, err
	}

	destination, err := s.destination(ctx, userID, source.VaultID, in.ParentID)
	if err != nil {
		return nil, err
	}

	if err := s.matchesScope(destination, source.KeyScopeID, source.KeyVersion); err != nil {
		return nil, err
	}

	moved, err := s.files.MoveFile(ctx, fileID, in, userID)
	if err != nil {
		return nil, fmt.Errorf("move file: %w", err)
	}

	return moved, nil
}

func (s *Service) DeleteFile(ctx context.Context, userID, fileID int64) error {
	return s.setFileDeleted(ctx, userID, fileID, true)
}

func (s *Service) RestoreFile(ctx context.Context, userID, fileID int64) error {
	return s.setFileDeleted(ctx, userID, fileID, false)
}

func (s *Service) setFileDeleted(ctx context.Context, userID, fileID int64, deleted bool) error {
	if _, err := s.fileFor(ctx, userID, fileID, PermEdit); err != nil {
		return err
	}

	if err := s.files.SetFileDeleted(ctx, fileID, deleted, userID); err != nil {
		return fmt.Errorf("set file deleted: %w", err)
	}

	return nil
}

func (s *Service) PurgeFile(ctx context.Context, userID, fileID int64) error {
	if _, err := s.fileFor(ctx, userID, fileID, PermOwn); err != nil {
		return err
	}

	if err := s.files.PurgeFile(ctx, fileID); err != nil {
		return fmt.Errorf("purge file: %w", err)
	}

	return nil
}

func (s *Service) member(ctx context.Context, vaultID, userID int64) (*Membership, error) {
	member, err := s.vaults.Membership(ctx, vaultID, userID)
	if err != nil {
		// A vault the caller is not a member of is indistinguishable from one that does
		// not exist, so vault ids cannot be probed.
		return nil, translate(err, "read membership")
	}

	return member, nil
}

// destination resolves where a node is being created or moved to and checks the caller may
// write there. A nil folder means the vault root, whose permission is the role floor.
func (s *Service) destination(ctx context.Context, userID, vaultID int64, folderID *int64) (*Ref, error) {
	ref, err := s.tree.ParentRef(ctx, vaultID, userID, folderID)
	if err != nil {
		return nil, translate(err, "resolve destination")
	}

	if ref.Deleted {
		return nil, ErrNotFound
	}

	if !ref.Permission.AtLeast(PermEdit) {
		return nil, ErrForbidden
	}

	return ref, nil
}

func (s *Service) folderFor(ctx context.Context, userID, folderID int64, min Permission) (*Ref, error) {
	ref, err := s.folders.FolderRef(ctx, folderID, userID)
	if err != nil {
		return nil, translate(err, "read folder")
	}

	if !ref.Permission.AtLeast(min) {
		return nil, ErrForbidden
	}

	return ref, nil
}

func (s *Service) fileFor(ctx context.Context, userID, fileID int64, min Permission) (*Ref, error) {
	ref, err := s.files.FileRef(ctx, fileID, userID)
	if err != nil {
		return nil, translate(err, "read file")
	}

	if !ref.Permission.AtLeast(min) {
		return nil, ErrForbidden
	}

	return ref, nil
}

// matchesScope refuses ciphertext sealed under a key that does not belong at the
// destination. Accepting it would write a row nobody there can ever open, and the loss
// would only surface much later, when someone tried to read it.
func (s *Service) matchesScope(destination *Ref, scopeID int64, version int32) error {
	if destination.KeyScopeID == scopeID && destination.KeyVersion == version {
		return nil
	}

	s.log.Warn("rejected a write sealed under a foreign key scope",
		zap.Int64("vault_id", destination.VaultID),
		zap.Int64("destination_scope_id", destination.KeyScopeID),
		zap.Int32("destination_key_version", destination.KeyVersion),
		zap.Int64("declared_scope_id", scopeID),
		zap.Int32("declared_key_version", version),
	)

	return ErrScopeMismatch
}

// translate keeps the sentinel errors intact and wraps everything else with context.
func translate(err error, op string) error {
	switch {
	case errors.Is(err, ErrNotFound),
		errors.Is(err, ErrForbidden),
		errors.Is(err, ErrVersionConflict),
		errors.Is(err, ErrScopeMismatch),
		errors.Is(err, ErrCycle),
		errors.Is(err, ErrDepthExceeded),
		errors.Is(err, ErrOwnerRequired):
		return err
	default:
		return fmt.Errorf("%s: %w", op, err)
	}
}
