package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

func (r *VaultRepository) CreateFile(ctx context.Context, in vault.NewFile, actorID int64) (*vault.File, error) {
	var created *vault.File

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		seq, err := nextSeq(ctx, tx, in.VaultID)
		if err != nil {
			return err
		}

		const insert = `
			INSERT INTO files (client_id, vault_id, folder_id, key_scope_id, key_version,
			                   meta, meta_nonce, content, content_nonce, updated_seq, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			RETURNING ` + fileReturning

		row := tx.QueryRow(ctx, insert,
			in.ClientID, in.VaultID, in.FolderID, in.KeyScopeID, in.KeyVersion,
			in.Meta.Ciphertext, in.Meta.Nonce, in.Content.Ciphertext, in.Content.Nonce, seq, actorID,
		)

		file, err := scanFileBody(row)
		if err != nil {
			return fmt.Errorf("insert file: %w", err)
		}

		file.Access = vault.Access{Permission: vault.PermEdit}
		created = file

		return nil
	})
	if err != nil {
		return nil, err
	}

	return created, nil
}

func (r *VaultRepository) File(ctx context.Context, fileID, userID int64) (*vault.File, error) {
	vaultID, err := r.fileVault(ctx, fileID)
	if err != nil {
		return nil, err
	}

	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + fileBodyColumns + `,
		       fia.perm,
		       (ks.scope_type = 'file' AND ks.scope_ref_id = fi.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM files fi
		  JOIN file_access fia ON fia.id = fi.id
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = fi.key_scope_id
		 WHERE fi.id = $3 AND permission_rank(fia.perm) > 0`

	file, err := scanFileWithBody(r.pool.QueryRow(ctx, query, vaultID, userID, fileID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, err
	}

	return file, nil
}

// Files is the hydration path behind the local search index: it returns bodies in bulk,
// filtered to what the caller may read.
func (r *VaultRepository) Files(ctx context.Context, vaultID, userID int64, ids []int64) ([]vault.File, error) {
	if len(ids) == 0 {
		return []vault.File{}, nil
	}

	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + fileBodyColumns + `,
		       fia.perm,
		       (ks.scope_type = 'file' AND ks.scope_ref_id = fi.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM files fi
		  JOIN file_access fia ON fia.id = fi.id
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = fi.key_scope_id
		 WHERE fi.vault_id = $1 AND fi.id = ANY($3) AND permission_rank(fia.perm) > 0
		 ORDER BY fi.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, ids)
	if err != nil {
		return nil, fmt.Errorf("select files by id: %w", err)
	}
	defer rows.Close()

	files := make([]vault.File, 0, len(ids))

	for rows.Next() {
		file, err := scanFileWithBody(rows)
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

func (r *VaultRepository) UpdateFileMeta(
	ctx context.Context,
	fileID int64,
	in vault.MetaUpdate,
	actorID int64,
) (*vault.File, error) {
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx pgx.Tx, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files SET meta = $2, meta_nonce = $3, updated_seq = $4, updated_by = $5
			 WHERE id = $1
			RETURNING ` + fileReturning

		return scanFileBody(tx.QueryRow(ctx, update, fileID, in.Meta.Ciphertext, in.Meta.Nonce, seq, actorID))
	})
}

// UpdateFileContent writes a body under an optimistic lock. The server cannot merge two
// versions of a ciphertext it cannot read, so a stale sequence is refused and handed back
// to the client to resolve.
func (r *VaultRepository) UpdateFileContent(
	ctx context.Context,
	fileID int64,
	in vault.ContentUpdate,
	actorID int64,
) (*vault.File, error) {
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx pgx.Tx, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files
			   SET content = $2, content_nonce = $3, content_seq = content_seq + 1,
			       updated_seq = $4, updated_by = $5
			 WHERE id = $1 AND content_seq = $6
			RETURNING ` + fileReturning

		file, err := scanFileBody(tx.QueryRow(ctx, update,
			fileID, in.Content.Ciphertext, in.Content.Nonce, seq, actorID, in.ExpectedSeq))
		if errors.Is(err, pgx.ErrNoRows) {
			// The row is there, so the only reason the update matched nothing is the
			// sequence: somebody else wrote first.
			return nil, vault.ErrVersionConflict
		}

		return file, err
	})
}

func (r *VaultRepository) MoveFile(
	ctx context.Context,
	fileID int64,
	in vault.Move,
	actorID int64,
) (*vault.File, error) {
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx pgx.Tx, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files SET folder_id = $2, updated_seq = $3, updated_by = $4
			 WHERE id = $1
			RETURNING ` + fileReturning

		return scanFileBody(tx.QueryRow(ctx, update, fileID, in.ParentID, seq, actorID))
	})
}

func (r *VaultRepository) SetFileDeleted(ctx context.Context, fileID int64, deleted bool, actorID int64) error {
	_, err := r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx pgx.Tx, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files SET deleted_at = CASE WHEN $2 THEN now() ELSE NULL END,
			                 updated_seq = $3, updated_by = $4
			 WHERE id = $1
			RETURNING ` + fileReturning

		return scanFileBody(tx.QueryRow(ctx, update, fileID, deleted, seq, actorID))
	})

	return err
}

func (r *VaultRepository) PurgeFile(ctx context.Context, fileID int64) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM files WHERE id = $1`, fileID)
	if err != nil {
		return fmt.Errorf("purge file: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return vault.ErrNotFound
	}

	return nil
}

// FileRef resolves a note for a write without pulling its body along.
func (r *VaultRepository) FileRef(ctx context.Context, fileID, userID int64) (*vault.Ref, error) {
	vaultID, err := r.fileVault(ctx, fileID)
	if err != nil {
		return nil, err
	}

	query := accessCTE + `
		SELECT fi.vault_id, fi.id, fia.perm, fi.key_scope_id, fi.key_version, fi.deleted_at IS NOT NULL
		  FROM files fi
		  JOIN file_access fia ON fia.id = fi.id
		 WHERE fi.id = $3 AND permission_rank(fia.perm) > 0`

	var ref vault.Ref

	err = r.pool.QueryRow(ctx, query, vaultID, userID, fileID).Scan(
		&ref.VaultID, &ref.ID, &ref.Permission, &ref.KeyScopeID, &ref.KeyVersion, &ref.Deleted,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select file ref: %w", err)
	}

	return &ref, nil
}

// updateFile wraps the write pattern every note mutation shares: allocate the vault's next
// change sequence in the same transaction as the row, so a delta sync cannot step over it.
func (r *VaultRepository) updateFile(
	ctx context.Context,
	fileID, actorID int64,
	write func(ctx context.Context, tx pgx.Tx, seq int64) (*vault.File, error),
) (*vault.File, error) {
	var updated *vault.File

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		vaultID, err := fileVaultTx(ctx, tx, fileID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		file, err := write(ctx, tx, seq)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return err
		}

		updated = file

		return nil
	})
	if err != nil {
		return nil, err
	}

	return updated, nil
}

func (r *VaultRepository) fileVault(ctx context.Context, fileID int64) (int64, error) {
	var vaultID int64

	err := r.pool.QueryRow(ctx, `SELECT vault_id FROM files WHERE id = $1`, fileID).Scan(&vaultID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, vault.ErrNotFound
		}

		return 0, fmt.Errorf("select file vault: %w", err)
	}

	return vaultID, nil
}

func fileVaultTx(ctx context.Context, tx pgx.Tx, fileID int64) (int64, error) {
	var vaultID int64

	err := tx.QueryRow(ctx, `SELECT vault_id FROM files WHERE id = $1`, fileID).Scan(&vaultID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, vault.ErrNotFound
		}

		return 0, fmt.Errorf("select file vault: %w", err)
	}

	return vaultID, nil
}

func scanFileBody(row pgx.Row) (*vault.File, error) {
	var f vault.File

	err := row.Scan(
		&f.ID, &f.ClientID, &f.VaultID, &f.FolderID, &f.KeyScopeID, &f.KeyVersion,
		&f.Meta.Ciphertext, &f.Meta.Nonce, &f.ContentSeq, &f.InheritAccess,
		&f.UpdatedSeq, &f.UpdatedBy, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
		&f.Content.Ciphertext, &f.Content.Nonce, &f.ContentSize,
	)
	if err != nil {
		return nil, err
	}

	return &f, nil
}

func scanFileWithBody(row pgx.Row) (*vault.File, error) {
	var f vault.File

	err := row.Scan(
		&f.ID, &f.ClientID, &f.VaultID, &f.FolderID, &f.KeyScopeID, &f.KeyVersion,
		&f.Meta.Ciphertext, &f.Meta.Nonce, &f.ContentSeq, &f.InheritAccess,
		&f.UpdatedSeq, &f.UpdatedBy, &f.DeletedAt, &f.CreatedAt, &f.UpdatedAt,
		&f.Content.Ciphertext, &f.Content.Nonce, &f.ContentSize,
		&f.Access.Permission, &f.Access.OwnScope, &f.Access.GrantCount,
	)
	if err != nil {
		return nil, err
	}

	return &f, nil
}
