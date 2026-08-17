//go:build integration

// A hint that a vault moved is only safe once the move is durable. These tests hold the
// announcement to that: after the commit, never before it, and never at all for a
// transaction that rolled back — a listener told about a write that did not happen would
// pull a delta that contradicts what it was just told.
package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"

	"shelf/internal/vault"
)

// recorder stands in for the hub.
type recorder struct {
	mu          sync.Mutex
	calls       map[int64][]int64
	invalidated []int64
}

func (r *recorder) NoteInvalidated(fileID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.invalidated = append(r.invalidated, fileID)
}

func (r *recorder) replaced() []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()

	return append([]int64(nil), r.invalidated...)
}

func (r *recorder) VaultChanged(vaultID, changeSeq int64) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.calls == nil {
		r.calls = make(map[int64][]int64)
	}

	r.calls[vaultID] = append(r.calls[vaultID], changeSeq)
}

func (r *recorder) seen(vaultID int64) []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.calls[vaultID]
}

// A transaction that allocates twice announces once, at the sequence a reader has to catch
// up to. Announcing every allocation would wake every follower of a folder move as many
// times as the move touched rows.
func TestCommitAnnouncesOncePerVault(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)

	ctx := context.Background()
	rec := &recorder{}

	var last int64

	err := inTx(ctx, pool, rec, func(tx *txn) error {
		for range 3 {
			seq, err := nextSeq(ctx, tx, f.vaultID)
			if err != nil {
				return err
			}

			last = seq
		}

		return nil
	})
	if err != nil {
		t.Fatalf("transaction: %v", err)
	}

	seen := rec.seen(f.vaultID)
	if len(seen) != 1 {
		t.Fatalf("announced %d times, want once", len(seen))
	}

	if seen[0] != last {
		t.Fatalf("announced sequence %d, want the highest allocated %d", seen[0], last)
	}
}

func TestRollbackAnnouncesNothing(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)

	ctx := context.Background()
	rec := &recorder{}

	var before int64
	if err := pool.QueryRow(ctx, `SELECT change_seq FROM vaults WHERE id = $1`, f.vaultID).Scan(&before); err != nil {
		t.Fatalf("read sequence: %v", err)
	}

	boom := errors.New("boom")

	err := inTx(ctx, pool, rec, func(tx *txn) error {
		if _, err := nextSeq(ctx, tx, f.vaultID); err != nil {
			return err
		}

		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatalf("transaction returned %v, want the handler's error", err)
	}

	if seen := rec.seen(f.vaultID); len(seen) != 0 {
		t.Fatalf("a rolled back transaction announced %v", seen)
	}

	var after int64
	if err := pool.QueryRow(ctx, `SELECT change_seq FROM vaults WHERE id = $1`, f.vaultID).Scan(&after); err != nil {
		t.Fatalf("read sequence: %v", err)
	}

	if after != before {
		t.Fatalf("the sequence moved from %d to %d despite the rollback", before, after)
	}
}

// A nil announcer is the ordinary state of every non-serving caller: the migrations, the
// tests, anything that is not the running service.
func TestNilAnnouncerIsSilent(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)

	ctx := context.Background()

	err := inTx(ctx, pool, nil, func(tx *txn) error {
		_, err := nextSeq(ctx, tx, f.vaultID)

		return err
	})
	if err != nil {
		t.Fatalf("transaction with no announcer: %v", err)
	}
}
