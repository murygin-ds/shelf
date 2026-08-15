package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// checkViolation is the PostgreSQL error code of a failed CHECK constraint.
const checkViolation = "23514"

func (r *VaultRepository) CreateFolder(
	ctx context.Context,
	in vault.NewFolder,
	actorID int64,
) (*vault.Folder, error) {
	var created *vault.Folder

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		seq, err := nextSeq(ctx, tx, in.VaultID)
		if err != nil {
			return err
		}

		const insert = `
			INSERT INTO folders (client_id, vault_id, parent_id, key_scope_id, key_version,
			                     meta, meta_nonce, depth, position, updated_seq, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7,
			        COALESCE((SELECT depth + 1 FROM folders WHERE id = $3), 0), $8, $9, $10)
			RETURNING ` + folderReturning

		row := tx.QueryRow(ctx, insert,
			in.ClientID, in.VaultID, in.ParentID, in.KeyScopeID, in.KeyVersion,
			in.Meta.Ciphertext, in.Meta.Nonce, in.Position, seq, actorID,
		)

		folder, err := scanFolder(row)
		if err != nil {
			return fmt.Errorf("insert folder: %w", mapConstraint(err))
		}

		// A folder created by an editor is theirs to manage, so the effective permission
		// is at least what the caller had on the parent. The tree read resolves it
		// properly; this keeps the immediate response honest.
		folder.Access = vault.Access{Permission: vault.PermEdit}
		created = folder

		return nil
	})
	if err != nil {
		return nil, err
	}

	return created, nil
}

func (r *VaultRepository) Folder(ctx context.Context, folderID, userID int64) (*vault.Folder, error) {
	vaultID, err := r.folderVault(ctx, folderID)
	if err != nil {
		return nil, err
	}

	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + folderColumns + `,
		       fa.perm,
		       (ks.scope_type = 'folder' AND ks.scope_ref_id = f.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM folders f
		  JOIN folder_access fa ON fa.id = f.id
		  JOIN key_scopes ks ON ks.id = f.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = f.key_scope_id
		 WHERE f.id = $3 AND permission_rank(fa.perm) > 0`

	folder, err := scanFolderRow(r.pool.QueryRow(ctx, query, vaultID, userID, folderID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, err
	}

	return folder, nil
}

// FolderRef resolves a folder for a write without pulling its ciphertext along.
func (r *VaultRepository) FolderRef(ctx context.Context, folderID, userID int64) (*vault.Ref, error) {
	vaultID, err := r.folderVault(ctx, folderID)
	if err != nil {
		return nil, err
	}

	query := accessCTE + `
		SELECT f.vault_id, f.id, fa.perm, f.key_scope_id, f.key_version, f.deleted_at IS NOT NULL
		  FROM folders f
		  JOIN folder_access fa ON fa.id = f.id
		 WHERE f.id = $3 AND permission_rank(fa.perm) > 0`

	var ref vault.Ref

	err = r.pool.QueryRow(ctx, query, vaultID, userID, folderID).Scan(
		&ref.VaultID, &ref.ID, &ref.Permission, &ref.KeyScopeID, &ref.KeyVersion, &ref.Deleted,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Invisible and non-existent answer the same way, so ids cannot be probed.
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select folder ref: %w", err)
	}

	return &ref, nil
}

func (r *VaultRepository) UpdateFolderMeta(
	ctx context.Context,
	folderID int64,
	in vault.MetaUpdate,
	actorID int64,
) (*vault.Folder, error) {
	var updated *vault.Folder

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		vaultID, err := folderVaultTx(ctx, tx, folderID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const update = `
			UPDATE folders
			   SET meta = $2, meta_nonce = $3,
			       position = COALESCE($4, position),
			       updated_seq = $5, updated_by = $6
			 WHERE id = $1
			RETURNING ` + folderReturning

		row := tx.QueryRow(ctx, update, folderID, in.Meta.Ciphertext, in.Meta.Nonce, in.Position, seq, actorID)

		folder, err := scanFolder(row)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("update folder: %w", err)
		}

		updated = folder

		return nil
	})
	if err != nil {
		return nil, err
	}

	return updated, nil
}

// MoveFolder relinks a folder and repairs the depth of everything under it. The depth
// CHECK is what turns an over-deep move into a refusal rather than a query that never
// finishes walking the tree.
func (r *VaultRepository) MoveFolder(
	ctx context.Context,
	folderID int64,
	in vault.Move,
	actorID int64,
) (*vault.Folder, error) {
	var moved *vault.Folder

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		vaultID, err := folderVaultTx(ctx, tx, folderID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const update = `
			UPDATE folders
			   SET parent_id = $2,
			       position = $3,
			       depth = COALESCE((SELECT depth + 1 FROM folders WHERE id = $2), 0),
			       updated_seq = $4, updated_by = $5
			 WHERE id = $1
			RETURNING ` + folderReturning

		row := tx.QueryRow(ctx, update, folderID, in.ParentID, in.Position, seq, actorID)

		folder, err := scanFolder(row)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("move folder: %w", mapConstraint(err))
		}

		const repairDepth = `
			WITH RECURSIVE subtree AS (
			    SELECT id, depth FROM folders WHERE id = $1
			    UNION ALL
			    SELECT c.id, s.depth + 1 FROM folders c JOIN subtree s ON c.parent_id = s.id
			)
			UPDATE folders f SET depth = s.depth, updated_seq = $2, updated_by = $3
			  FROM subtree s
			 WHERE f.id = s.id AND f.depth <> s.depth`

		if _, err := tx.Exec(ctx, repairDepth, folderID, seq, actorID); err != nil {
			return fmt.Errorf("repair subtree depth: %w", mapConstraint(err))
		}

		moved = folder

		return nil
	})
	if err != nil {
		return nil, err
	}

	return moved, nil
}

// IsDescendant reports whether candidateAncestorID sits anywhere below folderID. A move
// that ignored this would build a cycle the resolution query would walk forever.
func (r *VaultRepository) IsDescendant(ctx context.Context, folderID, candidateAncestorID int64) (bool, error) {
	const query = `
		WITH RECURSIVE ancestors AS (
		    SELECT id, parent_id FROM folders WHERE id = $1
		    UNION ALL
		    SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
		)
		SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = $2)`

	var found bool
	if err := r.pool.QueryRow(ctx, query, folderID, candidateAncestorID).Scan(&found); err != nil {
		return false, fmt.Errorf("select folder ancestors: %w", err)
	}

	return found, nil
}

// SetFolderDeleted moves a whole subtree in or out of the trash, notes included, so a
// restored folder comes back with its contents.
func (r *VaultRepository) SetFolderDeleted(
	ctx context.Context,
	folderID int64,
	deleted bool,
	actorID int64,
) error {
	return inTx(ctx, r.pool, func(tx pgx.Tx) error {
		vaultID, err := folderVaultTx(ctx, tx, folderID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const subtree = `
			WITH RECURSIVE subtree AS (
			    SELECT id FROM folders WHERE id = $1
			    UNION ALL
			    SELECT c.id FROM folders c JOIN subtree s ON c.parent_id = s.id
			)`

		const updateFolders = subtree + `
			UPDATE folders SET deleted_at = CASE WHEN $2 THEN now() ELSE NULL END,
			                   updated_seq = $3, updated_by = $4
			 WHERE id IN (SELECT id FROM subtree)`

		if _, err := tx.Exec(ctx, updateFolders, folderID, deleted, seq, actorID); err != nil {
			return fmt.Errorf("set folder deleted: %w", err)
		}

		const updateFiles = subtree + `
			UPDATE files SET deleted_at = CASE WHEN $2 THEN now() ELSE NULL END,
			                 updated_seq = $3, updated_by = $4
			 WHERE folder_id IN (SELECT id FROM subtree)`

		if _, err := tx.Exec(ctx, updateFiles, folderID, deleted, seq, actorID); err != nil {
			return fmt.Errorf("set folder files deleted: %w", err)
		}

		return nil
	})
}

// PurgeFolder destroys the subtree for good. The ON DELETE CASCADE on parent_id and
// folder_id takes the descendants and their notes with it, so the tombstones have to be
// written first: after the delete there is nothing left to enumerate.
func (r *VaultRepository) PurgeFolder(ctx context.Context, folderID int64) error {
	return inTx(ctx, r.pool, func(tx pgx.Tx) error {
		vaultID, err := folderVaultTx(ctx, tx, folderID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const tombstones = `
			WITH RECURSIVE subtree AS (
			    SELECT id FROM folders WHERE id = $1
			    UNION ALL
			    SELECT c.id FROM folders c JOIN subtree s ON c.parent_id = s.id
			)
			INSERT INTO purged_entities (vault_id, entity_type, entity_id, purged_seq)
			SELECT $2, 'folder', id, $3 FROM subtree
			UNION ALL
			SELECT $2, 'file', id, $3 FROM files WHERE folder_id IN (SELECT id FROM subtree)
			ON CONFLICT (entity_type, entity_id) DO UPDATE SET purged_seq = EXCLUDED.purged_seq`

		if _, err := tx.Exec(ctx, tombstones, folderID, vaultID, seq); err != nil {
			return fmt.Errorf("record purged subtree: %w", err)
		}

		tag, err := tx.Exec(ctx, `DELETE FROM folders WHERE id = $1`, folderID)
		if err != nil {
			return fmt.Errorf("purge folder: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return vault.ErrNotFound
		}

		return nil
	})
}

func (r *VaultRepository) folderVault(ctx context.Context, folderID int64) (int64, error) {
	var vaultID int64

	err := r.pool.QueryRow(ctx, `SELECT vault_id FROM folders WHERE id = $1`, folderID).Scan(&vaultID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, vault.ErrNotFound
		}

		return 0, fmt.Errorf("select folder vault: %w", err)
	}

	return vaultID, nil
}

func folderVaultTx(ctx context.Context, tx pgx.Tx, folderID int64) (int64, error) {
	var vaultID int64

	err := tx.QueryRow(ctx, `SELECT vault_id FROM folders WHERE id = $1`, folderID).Scan(&vaultID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, vault.ErrNotFound
		}

		return 0, fmt.Errorf("select folder vault: %w", err)
	}

	return vaultID, nil
}

func scanFolder(row pgx.Row) (*vault.Folder, error) {
	var f vault.Folder

	err := row.Scan(
		&f.ID, &f.ClientID, &f.VaultID, &f.ParentID, &f.KeyScopeID, &f.KeyVersion,
		&f.Meta.Ciphertext, &f.Meta.Nonce, &f.InheritAccess, &f.Depth, &f.Position,
		&f.UpdatedSeq, &f.UpdatedBy, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	return &f, nil
}

// mapConstraint turns the CHECK constraints that guard the tree shape into domain errors.
func mapConstraint(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != checkViolation {
		return err
	}

	if strings.Contains(pgErr.ConstraintName, "depth") {
		return vault.ErrDepthExceeded
	}

	return vault.ErrCycle
}
