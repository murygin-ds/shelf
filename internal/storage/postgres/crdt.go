package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

const crdtDocColumns = `file_id, vault_id, key_scope_id, key_version, epoch, committed_seq,
	snapshot, snapshot_nonce, snapshot_seq, last_seq, pending_count, pending_bytes,
	created_by, created_at, updated_at`

// CRDTDoc reads the live document behind a note.
func (r *VaultRepository) CRDTDoc(ctx context.Context, fileID int64) (*vault.CRDTDoc, error) {
	query := `SELECT ` + crdtDocColumns + ` FROM file_crdt_docs WHERE file_id = $1`

	doc, err := scanCRDTDoc(r.pool.QueryRow(ctx, query, fileID))
	if err != nil {
		return nil, err
	}

	return doc, nil
}

// SeedCRDTDoc creates the document, or hands back the one that got there first.
//
// The arbitration is the unique primary key, not a timing window: two clients opening an
// unedited note both insert, exactly one row survives, and the loser is handed the winner's
// state so it can throw its own away. Merging two independently seeded documents would put
// the text in twice, because each carries its own client identifier for the same
// characters.
func (r *VaultRepository) SeedCRDTDoc(
	ctx context.Context,
	in vault.NewCRDTDoc,
	actorID int64,
) (*vault.CRDTDoc, bool, error) {
	var (
		doc    *vault.CRDTDoc
		seeded bool
	)

	err := r.inTx(ctx, func(tx *txn) error {
		var (
			vaultID    int64
			contentSeq int64
		)

		const readFile = `
			SELECT vault_id, content_seq FROM files
			 WHERE id = $1 AND deleted_at IS NULL`

		if err := tx.QueryRow(ctx, readFile, in.FileID).Scan(&vaultID, &contentSeq); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("read note: %w", err)
		}

		// A document seeded from a body that has already moved would start from text
		// nobody else holds, and every edit made on it would be written against it.
		if contentSeq != in.ContentSeq {
			return vault.ErrVersionConflict
		}

		const insert = `
			INSERT INTO file_crdt_docs (file_id, vault_id, key_scope_id, key_version,
			                            committed_seq, snapshot, snapshot_nonce, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (file_id) DO NOTHING
			RETURNING ` + crdtDocColumns

		created, err := scanCRDTDoc(tx.QueryRow(ctx, insert,
			in.FileID, vaultID, in.KeyScopeID, in.KeyVersion, in.ContentSeq,
			in.Snapshot.Ciphertext, in.Snapshot.Nonce, actorID,
		))

		switch {
		case err == nil:
			doc, seeded = created, true

			return nil

		case errors.Is(err, vault.ErrNotFound):
			// Nothing was inserted, so somebody seeded first.
			existing, err := scanCRDTDoc(tx.QueryRow(ctx,
				`SELECT `+crdtDocColumns+` FROM file_crdt_docs WHERE file_id = $1`, in.FileID))
			if err != nil {
				return err
			}

			doc = existing

			return nil

		default:
			return err
		}
	})
	if err != nil {
		return nil, false, err
	}

	return doc, seeded, nil
}

// CRDTUpdates reads the log past a sequence the caller already holds.
func (r *VaultRepository) CRDTUpdates(
	ctx context.Context,
	fileID int64,
	epoch int32,
	since int64,
) ([]vault.CRDTUpdate, error) {
	const query = `
		SELECT seq, epoch, payload, nonce, author_id, author_signature, created_at
		  FROM file_crdt_updates
		 WHERE file_id = $1 AND epoch = $2 AND seq > $3
		 ORDER BY seq`

	rows, err := r.pool.Query(ctx, query, fileID, epoch, since)
	if err != nil {
		return nil, fmt.Errorf("read live updates: %w", err)
	}

	defer rows.Close()

	updates := make([]vault.CRDTUpdate, 0)

	for rows.Next() {
		var update vault.CRDTUpdate

		err := rows.Scan(&update.Seq, &update.Epoch, &update.Payload.Ciphertext,
			&update.Payload.Nonce, &update.AuthorID, &update.Signature, &update.CreatedAt)
		if err != nil {
			return nil, fmt.Errorf("scan live update: %w", err)
		}

		updates = append(updates, update)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read live updates: %w", err)
	}

	return updates, nil
}

// AppendCRDTUpdate stores one update and gives it its place in the log.
//
// The sequence is allocated under the document row's lock, which is what keeps the log
// gap-free under concurrent writers — the same reason next_vault_seq holds a lock on the
// vault row. The change sequence of the vault is deliberately not moved: an update is
// delivered over the socket, and waking every poller on a keystroke is the opposite of
// what the socket is for.
func (r *VaultRepository) AppendCRDTUpdate(
	ctx context.Context,
	in vault.NewCRDTUpdate,
	actorID int64,
) (*vault.CRDTUpdate, error) {
	var stored vault.CRDTUpdate

	err := r.inTx(ctx, func(tx *txn) error {
		var (
			vaultID      int64
			epoch        int32
			lastSeq      int64
			pendingCount int32
			pendingBytes int64
		)

		const lockDoc = `
			SELECT vault_id, epoch, last_seq, pending_count, pending_bytes
			  FROM file_crdt_docs WHERE file_id = $1 FOR UPDATE`

		err := tx.QueryRow(ctx, lockDoc, in.FileID).
			Scan(&vaultID, &epoch, &lastSeq, &pendingCount, &pendingBytes)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrNotFound
			}

			return fmt.Errorf("lock live document: %w", err)
		}

		if epoch != in.Epoch {
			return vault.ErrEpochMismatch
		}

		size := int64(len(in.Payload.Ciphertext))

		if pendingCount >= vault.MaxPendingUpdates || pendingBytes+size > vault.MaxPendingBytes {
			return vault.ErrCompactRequired
		}

		const insert = `
			INSERT INTO file_crdt_updates (file_id, vault_id, key_scope_id, key_version,
			                               epoch, seq, payload, nonce, author_id, author_signature)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING seq, epoch, payload, nonce, author_id, author_signature, created_at`

		err = tx.QueryRow(ctx, insert,
			in.FileID, vaultID, in.KeyScopeID, in.KeyVersion, in.Epoch, lastSeq+1,
			in.Payload.Ciphertext, in.Payload.Nonce, actorID, signatureOrNil(in.Signature),
		).Scan(&stored.Seq, &stored.Epoch, &stored.Payload.Ciphertext, &stored.Payload.Nonce,
			&stored.AuthorID, &stored.Signature, &stored.CreatedAt)
		if err != nil {
			return fmt.Errorf("insert live update: %w", err)
		}

		const bump = `
			UPDATE file_crdt_docs
			   SET last_seq = $2, pending_count = pending_count + 1, pending_bytes = pending_bytes + $3
			 WHERE file_id = $1`

		if _, err := tx.Exec(ctx, bump, in.FileID, stored.Seq, size); err != nil {
			return fmt.Errorf("record pending update: %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return &stored, nil
}

// signatureOrNil keeps an unsigned update visibly unsigned rather than stored as an empty
// signature, which would read as "signed with nothing".
func signatureOrNil(signature []byte) []byte {
	if len(signature) == 0 {
		return nil
	}

	return signature
}

func scanCRDTDoc(row pgx.Row) (*vault.CRDTDoc, error) {
	var (
		doc      vault.CRDTDoc
		snapshot []byte
		nonce    []byte
	)

	err := row.Scan(&doc.FileID, &doc.VaultID, &doc.KeyScopeID, &doc.KeyVersion, &doc.Epoch,
		&doc.CommittedSeq, &snapshot, &nonce, &doc.SnapshotSeq, &doc.LastSeq,
		&doc.PendingCount, &doc.PendingBytes, &doc.CreatedBy, &doc.CreatedAt, &doc.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("scan live document: %w", err)
	}

	if snapshot != nil {
		doc.Snapshot = &vault.Blob{Ciphertext: snapshot, Nonce: nonce}
	}

	return &doc, nil
}
