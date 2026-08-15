package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

// Tree returns the folders and notes the caller may see, with the effective permission
// already resolved. Bodies are left out on purpose: the tree is the cheap tier of the
// sync, and note bodies are fetched in bulk afterwards.
func (r *VaultRepository) Tree(
	ctx context.Context,
	vaultID, userID int64,
	deleted bool,
) ([]vault.Folder, []vault.File, error) {
	folders, err := r.treeFolders(ctx, vaultID, userID, deleted)
	if err != nil {
		return nil, nil, err
	}

	files, err := r.treeFiles(ctx, vaultID, userID, deleted)
	if err != nil {
		return nil, nil, err
	}

	return folders, files, nil
}

func (r *VaultRepository) treeFolders(
	ctx context.Context,
	vaultID, userID int64,
	deleted bool,
) ([]vault.Folder, error) {
	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + folderColumns + `,
		       fa.perm,
		       (ks.scope_type = 'folder' AND ks.scope_ref_id = f.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM folders f
		  JOIN folder_access fa ON fa.id = f.id
		  JOIN key_scopes ks ON ks.id = f.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = f.key_scope_id
		 WHERE f.vault_id = $1
		   AND permission_rank(fa.perm) > 0
		   AND (f.deleted_at IS NOT NULL) = $3
		 ORDER BY f.depth, f.position, f.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, deleted)
	if err != nil {
		return nil, fmt.Errorf("select folders: %w", err)
	}
	defer rows.Close()

	folders := make([]vault.Folder, 0)

	for rows.Next() {
		folder, err := scanFolderRow(rows)
		if err != nil {
			return nil, err
		}

		folders = append(folders, *folder)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate folders: %w", err)
	}

	return folders, nil
}

func (r *VaultRepository) treeFiles(
	ctx context.Context,
	vaultID, userID int64,
	deleted bool,
) ([]vault.File, error) {
	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + fileColumns + `,
		       octet_length(fi.content),
		       fia.perm,
		       (ks.scope_type = 'file' AND ks.scope_ref_id = fi.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM files fi
		  JOIN file_access fia ON fia.id = fi.id
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = fi.key_scope_id
		 WHERE fi.vault_id = $1
		   AND permission_rank(fia.perm) > 0
		   AND (fi.deleted_at IS NOT NULL) = $3
		 ORDER BY fi.folder_id NULLS FIRST, fi.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, deleted)
	if err != nil {
		return nil, fmt.Errorf("select files: %w", err)
	}
	defer rows.Close()

	files := make([]vault.File, 0)

	for rows.Next() {
		file, err := scanFileRow(rows)
		if err != nil {
			return nil, err
		}

		files = append(files, *file)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate files: %w", err)
	}

	return files, nil
}

// ParentRef resolves where a node is about to be created or moved. A nil folder means the
// vault root, whose permission is the caller's role floor and whose key scope is the
// vault's own.
func (r *VaultRepository) ParentRef(
	ctx context.Context,
	vaultID, userID int64,
	folderID *int64,
) (*vault.Ref, error) {
	if folderID != nil {
		return r.FolderRef(ctx, *folderID, userID)
	}

	const query = `
		SELECT ks.id, ks.key_version, role_permission(vm.role)
		  FROM key_scopes ks
		  JOIN vault_members vm ON vm.vault_id = ks.vault_id AND vm.user_id = $2
		 WHERE ks.vault_id = $1 AND ks.scope_type = 'vault' AND ks.scope_ref_id = $1`

	ref := vault.Ref{VaultID: vaultID}

	err := r.pool.QueryRow(ctx, query, vaultID, userID).Scan(&ref.KeyScopeID, &ref.KeyVersion, &ref.Permission)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select vault root: %w", err)
	}

	return &ref, nil
}

func scanFolderRow(row pgx.Row) (*vault.Folder, error) {
	var f vault.Folder

	err := row.Scan(
		&f.ID, &f.ClientID, &f.VaultID, &f.ParentID, &f.KeyScopeID, &f.KeyVersion,
		&f.Meta.Ciphertext, &f.Meta.Nonce, &f.InheritAccess, &f.Depth, &f.Position,
		&f.UpdatedSeq, &f.UpdatedBy, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
		&f.Access.Permission, &f.Access.OwnScope, &f.Access.GrantCount,
	)
	if err != nil {
		return nil, fmt.Errorf("scan folder: %w", err)
	}

	return &f, nil
}

func scanFileRow(row pgx.Row) (*vault.File, error) {
	var f vault.File

	err := row.Scan(
		&f.ID, &f.ClientID, &f.VaultID, &f.FolderID, &f.KeyScopeID, &f.KeyVersion,
		&f.Meta.Ciphertext, &f.Meta.Nonce, &f.ContentSeq, &f.InheritAccess,
		&f.UpdatedSeq, &f.UpdatedBy, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
		&f.ContentSize, &f.Access.Permission, &f.Access.OwnScope, &f.Access.GrantCount,
	)
	if err != nil {
		return nil, fmt.Errorf("scan file: %w", err)
	}

	return &f, nil
}
