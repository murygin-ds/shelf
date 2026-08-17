package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

const shareColumns = `sl.id, sl.file_id, sl.vault_id, sl.content_seq,
	sl.created_by, COALESCE(u.display_name, ''), sl.expires_at, sl.revoked_at,
	sl.last_viewed_at, sl.view_count, sl.created_at`

const shareFrom = `
	  FROM share_links sl
	  LEFT JOIN users u ON u.id = sl.created_by`

func (r *VaultRepository) CreateShareLink(
	ctx context.Context,
	in vault.NewShareLink,
	actorID int64,
) (*vault.ShareLink, error) {
	const insert = `
		INSERT INTO share_links (file_id, vault_id, token_hash, meta, meta_nonce,
		                         content, content_nonce, content_seq, created_by, expires_at)
		SELECT $1, fi.vault_id, $2, $3, $4, $5, $6, $7, $8, $9
		  FROM files fi WHERE fi.id = $1
		RETURNING id`

	var linkID int64

	err := r.inTx(ctx, func(tx *txn) error {
		err := tx.QueryRow(ctx, insert,
			in.FileID, in.TokenHash, in.Meta.Ciphertext, in.Meta.Nonce,
			in.Content.Ciphertext, in.Content.Nonce, in.ContentSeq, actorID, in.ExpiresAt,
		).Scan(&linkID)
		if err != nil {
			if isUniqueViolation(err) {
				// Two links cannot share a token digest. Reaching this means the client
				// reused a secret, which would let one revocation close both.
				return vault.ErrVersionConflict
			}

			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("insert share link: %w", err)
		}

		vaultID, err := fileVaultTx(ctx, tx, in.FileID)
		if err != nil {
			return err
		}

		// Publishing a note changes who can read it as surely as any grant does.
		return recordAudit(ctx, tx, auditEntry{
			VaultID:    vaultID,
			ActorID:    actorID,
			Action:     vault.AuditShareOpened,
			TargetType: string(vault.ScopeFile),
			TargetID:   in.FileID,
		})
	})
	if err != nil {
		return nil, err
	}

	return r.ShareLink(ctx, linkID)
}

func (r *VaultRepository) ShareLink(ctx context.Context, linkID int64) (*vault.ShareLink, error) {
	query := `SELECT ` + shareColumns + shareFrom + ` WHERE sl.id = $1`

	link, err := scanShareLink(r.pool.QueryRow(ctx, query, linkID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, err
	}

	return link, nil
}

// ShareLinks lists the links on one note, revoked and expired ones included: a link that
// has been closed is part of what the owner needs to see.
func (r *VaultRepository) ShareLinks(ctx context.Context, fileID int64) ([]vault.ShareLink, error) {
	query := `SELECT ` + shareColumns + shareFrom + ` WHERE sl.file_id = $1 ORDER BY sl.id DESC`

	rows, err := r.pool.Query(ctx, query, fileID)
	if err != nil {
		return nil, fmt.Errorf("select share links: %w", err)
	}
	defer rows.Close()

	links := make([]vault.ShareLink, 0)

	for rows.Next() {
		link, err := scanShareLink(rows)
		if err != nil {
			return nil, err
		}

		links = append(links, *link)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate share links: %w", err)
	}

	return links, nil
}

func (r *VaultRepository) RevokeShareLink(ctx context.Context, linkID, actorID int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		const revoke = `
			UPDATE share_links SET revoked_at = now()
			 WHERE id = $1 AND revoked_at IS NULL
			RETURNING vault_id, file_id`

		var vaultID, fileID int64

		err := tx.QueryRow(ctx, revoke, linkID).Scan(&vaultID, &fileID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("revoke share link: %w", err)
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:    vaultID,
			ActorID:    actorID,
			Action:     vault.AuditShareRevoked,
			TargetType: string(vault.ScopeFile),
			TargetID:   fileID,
		})
	})
}

// PublicNote resolves a link for a visitor with no account.
//
// Every reason it might fail is one condition, so the endpoint cannot be used to tell a
// live link from a revoked, expired or never-issued one. The row it returns is ciphertext
// plus the wrapped key: the server holds nothing that opens it.
func (r *VaultRepository) PublicNote(ctx context.Context, tokenHash []byte) (*vault.PublicNote, error) {
	const query = `
		SELECT fi.client_id, sl.meta, sl.meta_nonce, sl.content, sl.content_nonce, sl.created_at
		  FROM share_links sl
		  JOIN files fi ON fi.id = sl.file_id
		 WHERE sl.token_hash = $1
		   AND sl.revoked_at IS NULL
		   AND (sl.expires_at IS NULL OR sl.expires_at > now())
		   AND fi.deleted_at IS NULL`

	var note vault.PublicNote

	err := r.pool.QueryRow(ctx, query, tokenHash).Scan(
		&note.ClientID, &note.Meta.Ciphertext, &note.Meta.Nonce,
		&note.Content.Ciphertext, &note.Content.Nonce, &note.PublishedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select public note: %w", err)
	}

	// Best effort, and deliberately not part of the answer: the visitor already holds the
	// note, so failing their read over a counter would trade a working link for bookkeeping.
	const seen = `
		UPDATE share_links SET view_count = view_count + 1, last_viewed_at = now()
		 WHERE token_hash = $1`

	// The error is deliberately dropped: the visitor already holds the note, and failing
	// their read over a counter would trade a working link for bookkeeping.
	_, _ = r.pool.Exec(ctx, seen, tokenHash)

	return &note, nil
}

func scanShareLink(row pgx.Row) (*vault.ShareLink, error) {
	var link vault.ShareLink

	err := row.Scan(
		&link.ID, &link.FileID, &link.VaultID, &link.ContentSeq,
		&link.CreatedBy, &link.CreatorName, &link.ExpiresAt,
		&link.RevokedAt, &link.LastViewedAt, &link.ViewCount, &link.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan share link: %w", err)
	}

	return &link, nil
}
