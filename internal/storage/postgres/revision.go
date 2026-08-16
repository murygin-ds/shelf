package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

const revisionColumns = `rv.id, rv.file_id, rv.vault_id, rv.key_scope_id, ks.client_id,
	rv.key_version, rv.content_seq, octet_length(rv.content), rv.author_id,
	COALESCE(u.login, ''), COALESCE(u.display_name, ''), u.public_key,
	rv.author_signature, rv.created_at`

// recordRevision appends the body that was just written to the note's history, inside the
// same transaction that wrote it. A revision written separately could be lost while the
// note moved on, and history that silently skips a version is worse than none.
//
// Saves made close together by the same author fold into the newest entry instead of piling
// up: an editor that autosaves every couple of seconds would otherwise turn the history
// into a list nobody can read.
func recordRevision(
	ctx context.Context,
	tx pgx.Tx,
	file *vault.File,
	signature []byte,
	actorID int64,
) error {
	// Three conditions decide whether this save folds into the newest entry rather than
	// adding one:
	//   - the same author wrote it,
	//   - it is still the newest entry, so folding cannot step over somebody else's version
	//     and destroy the one they edited from,
	//   - the window is measured from when that entry was first opened, not from the last
	//     save into it, or a steady typist would collapse a whole day into one revision.
	const coalesce = `
		UPDATE file_revisions
		   SET content = $2, content_nonce = $3, content_seq = $4,
		       key_scope_id = $5, key_version = $6, author_signature = $7
		 WHERE id = (
		     SELECT r.id FROM file_revisions r
		      WHERE r.file_id = $1 AND r.author_id = $8
		        AND r.created_at > now() - $9::INTERVAL
		        AND r.content_seq = (SELECT max(content_seq) FROM file_revisions
		                              WHERE file_id = $1)
		      LIMIT 1
		 )`

	tag, err := tx.Exec(ctx, coalesce,
		file.ID, file.Content.Ciphertext, file.Content.Nonce, file.ContentSeq,
		file.KeyScopeID, file.KeyVersion, signature, actorID, vault.RevisionCoalesce.String(),
	)
	if err != nil {
		return fmt.Errorf("coalesce revision: %w", err)
	}

	if tag.RowsAffected() > 0 {
		return nil
	}

	const insert = `
		INSERT INTO file_revisions (file_id, vault_id, key_scope_id, key_version,
		                            content, content_nonce, content_seq,
		                            author_id, author_signature)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (file_id, content_seq) DO NOTHING`

	_, err = tx.Exec(ctx, insert,
		file.ID, file.VaultID, file.KeyScopeID, file.KeyVersion,
		file.Content.Ciphertext, file.Content.Nonce, file.ContentSeq, actorID, signature,
	)
	if err != nil {
		return fmt.Errorf("insert revision: %w", err)
	}

	return nil
}

// Revisions lists a note's history newest first, without the bodies. The listing carries
// each author's public key so a reader can check the signature without a second lookup
// that the server could answer differently.
func (r *VaultRepository) Revisions(
	ctx context.Context,
	fileID, userID int64,
	limit int,
) ([]vault.Revision, error) {
	vaultID, err := r.fileVault(ctx, fileID)
	if err != nil {
		return nil, err
	}

	query := accessCTE + `
		SELECT ` + revisionColumns + `
		  FROM file_revisions rv
		  JOIN key_scopes ks ON ks.id = rv.key_scope_id
		  JOIN file_access fia ON fia.id = rv.file_id
		  LEFT JOIN users u ON u.id = rv.author_id
		 WHERE rv.file_id = $3 AND permission_rank(fia.perm) > 0
		 ORDER BY rv.content_seq DESC
		 LIMIT $4`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, fileID, limit)
	if err != nil {
		return nil, fmt.Errorf("select revisions: %w", err)
	}
	defer rows.Close()

	list := make([]vault.Revision, 0, limit)

	for rows.Next() {
		revision, err := scanRevision(rows)
		if err != nil {
			return nil, err
		}

		list = append(list, *revision)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate revisions: %w", err)
	}

	return list, nil
}

// Revision reads one stored body. The permission check runs against the note the revision
// belongs to, so a revision id is no more of an oracle than the note id already is.
func (r *VaultRepository) Revision(ctx context.Context, revisionID, userID int64) (*vault.Revision, error) {
	var vaultID int64

	const owner = `SELECT vault_id FROM file_revisions WHERE id = $1`

	if err := r.pool.QueryRow(ctx, owner, revisionID).Scan(&vaultID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select revision vault: %w", err)
	}

	query := accessCTE + `
		SELECT ` + revisionColumns + `, rv.content, rv.content_nonce
		  FROM file_revisions rv
		  JOIN key_scopes ks ON ks.id = rv.key_scope_id
		  JOIN file_access fia ON fia.id = rv.file_id
		  LEFT JOIN users u ON u.id = rv.author_id
		 WHERE rv.id = $3 AND permission_rank(fia.perm) > 0`

	row := r.pool.QueryRow(ctx, query, vaultID, userID, revisionID)

	var revision vault.Revision

	err := row.Scan(
		&revision.ID, &revision.FileID, &revision.VaultID, &revision.KeyScopeID,
		&revision.KeyScopeClientID, &revision.KeyVersion, &revision.ContentSeq,
		&revision.ContentSize, &revision.AuthorID, &revision.AuthorLogin, &revision.AuthorName,
		&revision.AuthorPublicKey, &revision.Signature, &revision.CreatedAt,
		&revision.Content.Ciphertext, &revision.Content.Nonce,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Invisible and non-existent answer the same way, so ids cannot be probed.
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("scan revision: %w", err)
	}

	return &revision, nil
}

func scanRevision(row pgx.Row) (*vault.Revision, error) {
	var revision vault.Revision

	err := row.Scan(
		&revision.ID, &revision.FileID, &revision.VaultID, &revision.KeyScopeID,
		&revision.KeyScopeClientID, &revision.KeyVersion, &revision.ContentSeq,
		&revision.ContentSize, &revision.AuthorID, &revision.AuthorLogin, &revision.AuthorName,
		&revision.AuthorPublicKey, &revision.Signature, &revision.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan revision: %w", err)
	}

	return &revision, nil
}
