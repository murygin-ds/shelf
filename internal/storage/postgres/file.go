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

	err := r.inTx(ctx, func(tx *txn) error {
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
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx *txn, seq int64) (*vault.File, error) {
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
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx *txn, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files
			   SET content = $2, content_nonce = $3, content_seq = content_seq + 1,
			       updated_seq = $4, updated_by = $5
			 WHERE id = $1 AND content_seq = $6
			   AND key_scope_id = $7 AND key_version = $8
			RETURNING ` + fileReturning

		file, err := scanFileBody(tx.QueryRow(ctx, update,
			fileID, in.Content.Ciphertext, in.Content.Nonce, seq, actorID, in.ExpectedSeq,
			in.KeyScopeID, in.KeyVersion))
		if errors.Is(err, pgx.ErrNoRows) {
			// The row is there, so the update matched nothing for one of two reasons:
			// somebody wrote first, or the note was re-keyed under this write. Telling
			// them apart costs a second read and changes nothing the client does — both
			// mean "your copy is stale, fetch it again".
			return nil, vault.ErrVersionConflict
		}

		if err != nil {
			return nil, err
		}

		if err := recordRevision(ctx, tx, file, in.Signature, actorID); err != nil {
			return nil, err
		}

		if err := reconcileCRDT(ctx, tx, file, in.CRDT); err != nil {
			return nil, err
		}

		return file, nil
	})
}

// reconcileCRDT settles the live document against the body that was just written, in the
// same transaction as the write.
//
// Two cases, and the difference between them is whether the writer was speaking for the
// document. A commit from a live session folds the log into the snapshot it brought and
// prunes what that snapshot covers. Any other write — an offline body replayed from the
// outbox, a client too old to speak the socket — moved the body around the document, so
// the document is invalidated: its epoch rises, its log is dropped, and the next session
// seeds afresh from what was just written. Doing this anywhere but here would leave a
// window in which the body has moved and the document does not know.
func reconcileCRDT(ctx context.Context, tx *txn, file *vault.File, commit *vault.CRDTCommit) error {
	if commit == nil {
		const invalidate = `
			UPDATE file_crdt_docs
			   SET epoch = epoch + 1, snapshot = NULL, snapshot_nonce = NULL, snapshot_seq = 0,
			       last_seq = 0, committed_seq = $2, pending_count = 0, pending_bytes = 0
			 WHERE file_id = $1`

		tag, err := tx.Exec(ctx, invalidate, file.ID, file.ContentSeq)
		if err != nil {
			return fmt.Errorf("invalidate live document: %w", err)
		}

		if _, err := tx.Exec(ctx, `DELETE FROM file_crdt_updates WHERE file_id = $1`, file.ID); err != nil {
			return fmt.Errorf("drop live updates: %w", err)
		}

		// Only when there was a document to invalidate: every ordinary write goes through
		// here, and announcing one for a note nobody is editing is noise.
		if tag.RowsAffected() > 0 {
			tx.invalidate(file.ID)
		}

		return nil
	}

	const fold = `
		UPDATE file_crdt_docs
		   SET committed_seq = $2, snapshot = $3, snapshot_nonce = $4, snapshot_seq = $5,
		       pending_count = 0, pending_bytes = 0
		 WHERE file_id = $1 AND epoch = $6`

	tag, err := tx.Exec(ctx, fold, file.ID, file.ContentSeq,
		commit.Snapshot.Ciphertext, commit.Snapshot.Nonce, commit.UpToSeq, commit.Epoch)
	if err != nil {
		return fmt.Errorf("fold live document: %w", err)
	}

	// Nothing matched, so the document this commit speaks for has already been replaced.
	// The body it carries was folded from a document nobody holds any more.
	if tag.RowsAffected() == 0 {
		return vault.ErrEpochMismatch
	}

	const prune = `DELETE FROM file_crdt_updates WHERE file_id = $1 AND epoch = $2 AND seq <= $3`

	if _, err := tx.Exec(ctx, prune, file.ID, commit.Epoch, commit.UpToSeq); err != nil {
		return fmt.Errorf("prune live updates: %w", err)
	}

	return nil
}

func (r *VaultRepository) MoveFile(
	ctx context.Context,
	fileID int64,
	in vault.Move,
	actorID int64,
) (*vault.File, error) {
	return r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx *txn, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files SET folder_id = $2, updated_seq = $3, updated_by = $4
			 WHERE id = $1
			RETURNING ` + fileReturning

		return scanFileBody(tx.QueryRow(ctx, update, fileID, in.ParentID, seq, actorID))
	})
}

func (r *VaultRepository) SetFileDeleted(ctx context.Context, fileID int64, deleted bool, actorID int64) error {
	_, err := r.updateFile(ctx, fileID, actorID, func(ctx context.Context, tx *txn, seq int64) (*vault.File, error) {
		const update = `
			UPDATE files SET deleted_at = CASE WHEN $2 THEN now() ELSE NULL END,
			                 updated_seq = $3, updated_by = $4
			 WHERE id = $1
			RETURNING ` + fileReturning

		return scanFileBody(tx.QueryRow(ctx, update, fileID, deleted, seq, actorID))
	})

	return err
}

// PurgeFile destroys a note for good, leaving a tombstone so a client that was offline at
// the time still learns the note is gone rather than keeping it forever.
func (r *VaultRepository) PurgeFile(ctx context.Context, fileID int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		vaultID, err := fileVaultTx(ctx, tx, fileID)
		if err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const tombstone = `
			INSERT INTO purged_entities (vault_id, entity_type, entity_id, purged_seq)
			VALUES ($1, 'file', $2, $3)
			ON CONFLICT (entity_type, entity_id) DO UPDATE SET purged_seq = EXCLUDED.purged_seq`

		if _, err := tx.Exec(ctx, tombstone, vaultID, fileID, seq); err != nil {
			return fmt.Errorf("record purged file: %w", err)
		}

		tag, err := tx.Exec(ctx, `DELETE FROM files WHERE id = $1`, fileID)
		if err != nil {
			return fmt.Errorf("purge file: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return vault.ErrNotFound
		}

		return nil
	})
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
	write func(ctx context.Context, tx *txn, seq int64) (*vault.File, error),
) (*vault.File, error) {
	var updated *vault.File

	err := r.inTx(ctx, func(tx *txn) error {
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
		&f.ID, &f.ClientID, &f.VaultID, &f.FolderID, &f.KeyScopeClientID, &f.KeyScopeID, &f.KeyVersion,
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
		&f.ID, &f.ClientID, &f.VaultID, &f.FolderID, &f.KeyScopeClientID, &f.KeyScopeID, &f.KeyVersion,
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
