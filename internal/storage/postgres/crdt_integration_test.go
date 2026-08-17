//go:build integration

// The live document is the one place where two clients race by design: both open a note
// nobody has edited yet, and both try to start it. Everything here is about that race and
// about the ceilings that keep a log the server cannot merge from growing without end.
package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"

	"shelf/internal/vault"
)

func snapshot(text string) vault.Blob {
	return vault.Blob{Ciphertext: []byte(text), Nonce: []byte("nonce-1234567")}
}

// Two clients seeding at once must not end up with two documents. The loser is handed the
// winner's state and throws its own away: merging two independently seeded copies puts the
// text in twice, because each names the same characters with its own client id.
func TestConcurrentSeedsProduceOneDocument(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	type outcome struct {
		doc    *vault.CRDTDoc
		seeded bool
		err    error
	}

	results := make([]outcome, 2)

	var wg sync.WaitGroup

	for i := range results {
		wg.Add(1)

		go func() {
			defer wg.Done()

			doc, seeded, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
				FileID:     fileID,
				Snapshot:   snapshot("state"),
				KeyScopeID: f.scopeID,
				KeyVersion: 1,
				ContentSeq: 1,
			}, f.userID)

			results[i] = outcome{doc: doc, seeded: seeded, err: err}
		}()
	}

	wg.Wait()

	winners := 0

	for _, result := range results {
		if result.err != nil {
			t.Fatalf("seed: %v", result.err)
		}

		if result.seeded {
			winners++
		}

		if result.doc.Epoch != 1 {
			t.Errorf("seeded document has epoch %d, want 1", result.doc.Epoch)
		}
	}

	if winners != 1 {
		t.Fatalf("%d clients believe they seeded the document, want exactly 1", winners)
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM file_crdt_docs WHERE file_id = $1`, fileID).Scan(&rows); err != nil {
		t.Fatalf("count documents: %v", err)
	}

	if rows != 1 {
		t.Fatalf("%d documents exist for one note, want 1", rows)
	}
}

// A seed built from a body that has already moved would start from text nobody holds.
func TestSeedFromAStaleBodyIsRefused(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)

	_, _, err := repo.SeedCRDTDoc(context.Background(), vault.NewCRDTDoc{
		FileID:     fileID,
		Snapshot:   snapshot("state"),
		KeyScopeID: f.scopeID,
		KeyVersion: 1,
		ContentSeq: 99,
	}, f.userID)

	if !errors.Is(err, vault.ErrVersionConflict) {
		t.Fatalf("seed from a stale body returned %v, want a version conflict", err)
	}
}

// The log has to be gap-free under concurrent writers: a reader asking for everything past
// sequence N would otherwise silently miss whatever fell in a hole.
func TestConcurrentUpdatesGetContiguousSequences(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	if _, _, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: fileID, Snapshot: snapshot("state"),
		KeyScopeID: f.scopeID, KeyVersion: 1, ContentSeq: 1,
	}, f.userID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	const writers = 8

	var wg sync.WaitGroup

	for range writers {
		wg.Add(1)

		go func() {
			defer wg.Done()

			if _, err := repo.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
				FileID: fileID, Epoch: 1, Payload: snapshot("update"),
				KeyScopeID: f.scopeID, KeyVersion: 1,
			}, f.userID); err != nil {
				t.Errorf("append: %v", err)
			}
		}()
	}

	wg.Wait()

	updates, err := repo.CRDTUpdates(ctx, fileID, 1, 0)
	if err != nil {
		t.Fatalf("read updates: %v", err)
	}

	if len(updates) != writers {
		t.Fatalf("stored %d updates, want %d", len(updates), writers)
	}

	for i, update := range updates {
		if want := int64(i + 1); update.Seq != want {
			t.Fatalf("update %d carries sequence %d, want %d", i, update.Seq, want)
		}
	}

	doc, err := repo.CRDTDoc(ctx, fileID)
	if err != nil {
		t.Fatalf("read document: %v", err)
	}

	if doc.LastSeq != writers || doc.PendingCount != writers {
		t.Fatalf("document records %d/%d, want %d pending at sequence %d",
			doc.LastSeq, doc.PendingCount, writers, writers)
	}
}

// An update written against a document that has been replaced would merge an edit into
// text it was never written against.
func TestUpdateAgainstAnotherEpochIsRefused(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	if _, _, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: fileID, Snapshot: snapshot("state"),
		KeyScopeID: f.scopeID, KeyVersion: 1, ContentSeq: 1,
	}, f.userID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	_, err := repo.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
		FileID: fileID, Epoch: 2, Payload: snapshot("update"),
		KeyScopeID: f.scopeID, KeyVersion: 1,
	}, f.userID)

	if !errors.Is(err, vault.ErrEpochMismatch) {
		t.Fatalf("update against another epoch returned %v, want an epoch mismatch", err)
	}
}

// Only a client can compact the log, so the server's only defence against a document that
// grows without end is to stop accepting until one does.
func TestAFullLogRefusesMoreUpdates(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	if _, _, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: fileID, Snapshot: snapshot("state"),
		KeyScopeID: f.scopeID, KeyVersion: 1, ContentSeq: 1,
	}, f.userID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Filling the log an update at a time would take two thousand round trips; the
	// counters are what the check reads, so they are what the test sets.
	_, err := pool.Exec(ctx,
		`UPDATE file_crdt_docs SET pending_count = $2 WHERE file_id = $1`,
		fileID, vault.MaxPendingUpdates)
	if err != nil {
		t.Fatalf("fill the log: %v", err)
	}

	_, err = repo.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
		FileID: fileID, Epoch: 1, Payload: snapshot("update"),
		KeyScopeID: f.scopeID, KeyVersion: 1,
	}, f.userID)

	if !errors.Is(err, vault.ErrCompactRequired) {
		t.Fatalf("a full log returned %v, want a compaction demand", err)
	}
}

// Purging a note takes its document with it: the row exists to serve a note, and a log
// nobody can attribute to anything is a leak in a table nothing reads.
func TestPurgingANoteTakesItsDocument(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	if _, _, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: fileID, Snapshot: snapshot("state"),
		KeyScopeID: f.scopeID, KeyVersion: 1, ContentSeq: 1,
	}, f.userID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := repo.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
		FileID: fileID, Epoch: 1, Payload: snapshot("update"),
		KeyScopeID: f.scopeID, KeyVersion: 1,
	}, f.userID); err != nil {
		t.Fatalf("append: %v", err)
	}

	if _, err := pool.Exec(ctx, `DELETE FROM files WHERE id = $1`, fileID); err != nil {
		t.Fatalf("purge note: %v", err)
	}

	for _, table := range []string{"file_crdt_docs", "file_crdt_updates"} {
		var rows int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE file_id = $1`, fileID).Scan(&rows); err != nil {
			t.Fatalf("count %s: %v", table, err)
		}

		if rows != 0 {
			t.Errorf("%d rows left in %s after the note was purged", rows, table)
		}
	}
}

// seededDoc is a note with a live document and one update in its log.
func seededDoc(t *testing.T, f *fixture, repo *VaultRepository) int64 {
	t.Helper()

	ctx := context.Background()
	fileID := f.file(nil, true)

	if _, _, err := repo.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: fileID, Snapshot: snapshot("state"),
		KeyScopeID: f.scopeID, KeyVersion: 1, ContentSeq: 1,
	}, f.userID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if _, err := repo.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
		FileID: fileID, Epoch: 1, Payload: snapshot("update"),
		KeyScopeID: f.scopeID, KeyVersion: 1,
	}, f.userID); err != nil {
		t.Fatalf("append: %v", err)
	}

	return fileID
}

func body(f *fixture, expected int64, commit *vault.CRDTCommit) vault.ContentUpdate {
	return vault.ContentUpdate{
		Content:     snapshot("body"),
		ExpectedSeq: expected,
		KeyScopeID:  f.scopeID,
		KeyVersion:  1,
		CRDT:        commit,
	}
}

// A body written around the document — an offline write replayed from the outbox, or a
// client too old to speak the socket — moves the text out from under the live session. The
// document is invalidated rather than left claiming to describe a body it does not.
func TestABodyWrittenAroundTheDocumentInvalidatesIt(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	fileID := seededDoc(t, f, repo)

	if _, err := repo.UpdateFileContent(ctx, fileID, body(f, 1, nil), f.userID); err != nil {
		t.Fatalf("write body: %v", err)
	}

	doc, err := repo.CRDTDoc(ctx, fileID)
	if err != nil {
		t.Fatalf("read document: %v", err)
	}

	if doc.Epoch != 2 {
		t.Errorf("document is at epoch %d, want 2", doc.Epoch)
	}

	if doc.Snapshot != nil || doc.LastSeq != 0 || doc.PendingCount != 0 {
		t.Errorf("the invalidated document kept state: snapshot=%v last=%d pending=%d",
			doc.Snapshot != nil, doc.LastSeq, doc.PendingCount)
	}

	if doc.CommittedSeq != 2 {
		t.Errorf("document names body version %d, want the one just written", doc.CommittedSeq)
	}

	updates, err := repo.CRDTUpdates(ctx, fileID, 1, 0)
	if err != nil {
		t.Fatalf("read updates: %v", err)
	}

	if len(updates) != 0 {
		t.Errorf("%d updates survived the invalidation", len(updates))
	}
}

// A commit from the live session folds the log into the snapshot it brought.
func TestACommitFoldsTheLogAway(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	fileID := seededDoc(t, f, repo)

	commit := &vault.CRDTCommit{Epoch: 1, UpToSeq: 1, Snapshot: snapshot("folded")}

	if _, err := repo.UpdateFileContent(ctx, fileID, body(f, 1, commit), f.userID); err != nil {
		t.Fatalf("commit body: %v", err)
	}

	doc, err := repo.CRDTDoc(ctx, fileID)
	if err != nil {
		t.Fatalf("read document: %v", err)
	}

	if doc.Epoch != 1 {
		t.Errorf("a commit moved the document to epoch %d; it should stay on its own", doc.Epoch)
	}

	if doc.Snapshot == nil || string(doc.Snapshot.Ciphertext) != "folded" {
		t.Errorf("the committed snapshot was not stored")
	}

	if doc.CommittedSeq != 2 || doc.SnapshotSeq != 1 || doc.PendingCount != 0 {
		t.Errorf("document records committed=%d snapshot_seq=%d pending=%d, want 2/1/0",
			doc.CommittedSeq, doc.SnapshotSeq, doc.PendingCount)
	}

	updates, err := repo.CRDTUpdates(ctx, fileID, 1, 0)
	if err != nil {
		t.Fatalf("read updates: %v", err)
	}

	if len(updates) != 0 {
		t.Errorf("%d updates survived a commit that covered them", len(updates))
	}
}

// Everyone editing has to be told their document was replaced — and only then. Announcing
// on an ordinary commit would make every save look like a reason to start over.
func TestOnlyInvalidationIsAnnounced(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	rec := &recorder{}
	repo := NewVaultRepository(pool, rec)
	ctx := context.Background()

	fileID := seededDoc(t, f, repo)

	commit := &vault.CRDTCommit{Epoch: 1, UpToSeq: 1, Snapshot: snapshot("folded")}
	if _, err := repo.UpdateFileContent(ctx, fileID, body(f, 1, commit), f.userID); err != nil {
		t.Fatalf("commit body: %v", err)
	}

	if replaced := rec.replaced(); len(replaced) != 0 {
		t.Fatalf("a commit announced an invalidation: %v", replaced)
	}

	if _, err := repo.UpdateFileContent(ctx, fileID, body(f, 2, nil), f.userID); err != nil {
		t.Fatalf("write body: %v", err)
	}

	if replaced := rec.replaced(); len(replaced) != 1 || replaced[0] != fileID {
		t.Fatalf("invalidation announced %v, want exactly the note that moved", replaced)
	}
}

// A note nobody is editing has no document to invalidate, and saying otherwise would wake
// a room that does not exist on every ordinary save.
func TestAnOrdinaryWriteAnnouncesNothing(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	rec := &recorder{}
	repo := NewVaultRepository(pool, rec)

	fileID := f.file(nil, true)

	if _, err := repo.UpdateFileContent(context.Background(), fileID, body(f, 1, nil), f.userID); err != nil {
		t.Fatalf("write body: %v", err)
	}

	if replaced := rec.replaced(); len(replaced) != 0 {
		t.Fatalf("a write to a note with no document announced %v", replaced)
	}
}

// A commit naming an epoch that has been replaced was folded from a document nobody holds.
func TestACommitForAReplacedDocumentIsRefused(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewVaultRepository(pool, nil)
	ctx := context.Background()

	fileID := seededDoc(t, f, repo)

	commit := &vault.CRDTCommit{Epoch: 7, UpToSeq: 1, Snapshot: snapshot("folded")}

	_, err := repo.UpdateFileContent(ctx, fileID, body(f, 1, commit), f.userID)
	if !errors.Is(err, vault.ErrEpochMismatch) {
		t.Fatalf("a commit for a replaced document returned %v, want an epoch mismatch", err)
	}

	// The refusal has to take the body with it: a body folded from a document nobody holds
	// is exactly the write this check exists to stop.
	var contentSeq int64
	if err := pool.QueryRow(ctx, `SELECT content_seq FROM files WHERE id = $1`, fileID).Scan(&contentSeq); err != nil {
		t.Fatalf("read body version: %v", err)
	}

	if contentSeq != 1 {
		t.Fatalf("the body was written despite the refusal: version %d", contentSeq)
	}
}

// A document that does not exist is not an error to the reader — it is the state a note
// sits in until somebody opens it for editing.
func TestReadingAnUnseededDocument(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	fileID := f.file(nil, true)

	_, err := NewVaultRepository(pool, nil).CRDTDoc(context.Background(), fileID)
	if !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("reading an unseeded document returned %v, want not found", err)
	}
}
