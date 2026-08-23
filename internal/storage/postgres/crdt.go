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

// SeedCRDTDoc creates the document, refills the one a write from outside emptied, or hands
// back the one that got there first.
//
// The arbitration is the unique primary key, not a timing window: two clients opening an
// unedited note both insert, exactly one row survives, and the loser is handed the winner's
// state so it can throw its own away. Merging two independently seeded documents would put
// the text in twice, because each carries its own client identifier for the same
// characters.
//
// A row with no snapshot is the other case, and it is not somebody's document: a body
// written around the session left it there so the epoch could go on rising. Filling it
// keeps that epoch rather than resetting it, so an update still in flight against the
// document that was replaced is refused instead of merged into its successor. That is also
// why the seed has to name the epoch it was sealed under: seal and row must agree, or what
// is stored opens for nobody.
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

		current, err := scanCRDTDoc(tx.QueryRow(ctx,
			`SELECT `+crdtDocColumns+` FROM file_crdt_docs WHERE file_id = $1 FOR UPDATE`, in.FileID))

		switch {
		case err == nil && current.Snapshot != nil:
			doc = current

			return nil

		case err == nil:
			filled, err := refillCRDTDoc(ctx, tx, in, current.Epoch, actorID)
			if err != nil {
				return err
			}

			doc, seeded = filled, true

			return nil

		case errors.Is(err, vault.ErrNotFound):
			created, inserted, err := insertCRDTDoc(ctx, tx, in, vaultID, actorID)
			if err != nil {
				return err
			}

			doc, seeded = created, inserted

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

// insertCRDTDoc starts a document nobody has, or reads back the one that beat it there. The
// second result says which of the two happened.
func insertCRDTDoc(
	ctx context.Context,
	tx *txn,
	in vault.NewCRDTDoc,
	vaultID, actorID int64,
) (*vault.CRDTDoc, bool, error) {
	// Zero is a client that predates the epoch travelling in the frame, and a document
	// nobody has started is the one case where what it will seal under is not in doubt.
	if in.Epoch != 0 && in.Epoch != vault.FirstEpoch {
		return nil, false, vault.ErrEpochMismatch
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
		return created, true, nil

	case errors.Is(err, vault.ErrNotFound):
		// Nothing was inserted, so somebody seeded between the read above and here.
		existing, err := scanCRDTDoc(tx.QueryRow(ctx,
			`SELECT `+crdtDocColumns+` FROM file_crdt_docs WHERE file_id = $1`, in.FileID))

		return existing, false, err

	default:
		return nil, false, err
	}
}

// refillCRDTDoc puts a snapshot back into the row an invalidation emptied, at the epoch that
// row has reached.
func refillCRDTDoc(
	ctx context.Context,
	tx *txn,
	in vault.NewCRDTDoc,
	epoch int32,
	actorID int64,
) (*vault.CRDTDoc, error) {
	switch {
	// A client from before the epoch travelled in the frame cannot seal one of these, and
	// telling it to start over would only bring it back here: it is answered as the stale
	// copy it is holding, which is what it has to fix.
	case in.Epoch == 0:
		return nil, vault.ErrVersionConflict

	// Anything else named the wrong epoch — the document was invalidated again between
	// being offered and being seeded — and starting over lands on the current one.
	case in.Epoch != epoch:
		return nil, vault.ErrEpochMismatch
	}

	const refill = `
		UPDATE file_crdt_docs
		   SET key_scope_id = $2, key_version = $3, committed_seq = $4,
		       snapshot = $5, snapshot_nonce = $6, snapshot_seq = 0,
		       last_seq = 0, pending_count = 0, pending_bytes = 0, created_by = $7
		 WHERE file_id = $1 AND snapshot IS NULL
		RETURNING ` + crdtDocColumns

	return scanCRDTDoc(tx.QueryRow(ctx, refill,
		in.FileID, in.KeyScopeID, in.KeyVersion, in.ContentSeq,
		in.Snapshot.Ciphertext, in.Snapshot.Nonce, actorID,
	))
}

// PendingDocs names the notes among those given whose log still holds updates.
//
// The access CTE is here for the same reason it is on every other read of several notes at
// once: the ids come from a caller that may not see all of them, and «this note has edits
// nobody has written back» is something about a note.
func (r *VaultRepository) PendingDocs(
	ctx context.Context,
	vaultID, userID int64,
	fileIDs []int64,
) ([]int64, error) {
	if len(fileIDs) == 0 {
		return []int64{}, nil
	}

	query := accessCTE + `
		SELECT fd.file_id
		  FROM file_crdt_docs fd
		  JOIN file_access fia ON fia.id = fd.file_id
		 WHERE fd.vault_id = $1 AND fd.file_id = ANY($3)
		   AND fd.pending_count > 0 AND permission_rank(fia.perm) > 0`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, fileIDs)
	if err != nil {
		return nil, fmt.Errorf("select live documents with pending updates: %w", err)
	}
	defer rows.Close()

	pending := make([]int64, 0, len(fileIDs))

	for rows.Next() {
		var fileID int64

		if err := rows.Scan(&fileID); err != nil {
			return nil, fmt.Errorf("scan live document: %w", err)
		}

		pending = append(pending, fileID)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read live documents: %w", err)
	}

	return pending, nil
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
