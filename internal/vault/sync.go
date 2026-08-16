package vault

import "context"

// DefaultSyncLimit is a soft page size: a page always ends on a change-sequence boundary,
// so it can overshoot slightly rather than split one write across two pages.
const DefaultSyncLimit = 500

// MaxSyncLimit bounds what a client may ask for in one page.
const MaxSyncLimit = 2000

// Purged lists the nodes that were destroyed outright. A soft delete needs no tombstone:
// the row survives with a deletion timestamp and travels as an ordinary update.
type Purged struct {
	Folders []int64
	Files   []int64
}

// Delta is one page of changes since a cursor.
type Delta struct {
	// Cursor is what the next request sends back. It is a change sequence, never a
	// timestamp: two rows written in one transaction share a clock reading, and a reader
	// that interleaved between them would drop one of them for good.
	Cursor  int64
	HasMore bool
	// FullResync tells the client to drop its cached copy of this vault and start over.
	// It is the only way a client learns to forget plaintext it cached before losing
	// access to it, because the server cannot know what it already holds.
	FullResync bool
	Folders    []Folder
	Files      []File
	Purged     Purged
}

// SyncRepository reads the change feed of one vault.
type SyncRepository interface {
	// Sync returns every change after the cursor, up to a page boundary. A page always
	// ends where one change sequence ends, so a client that stores the returned cursor
	// can never step over a half-delivered write.
	Sync(ctx context.Context, vaultID, userID, cursor int64, limit int) (*Delta, error)
}

// Sync returns the changes a member has not seen yet.
func (s *Service) Sync(ctx context.Context, userID, vaultID, cursor int64, limit int) (*Delta, error) {
	member, err := s.member(ctx, vaultID, userID)
	if err != nil {
		return nil, err
	}

	if limit <= 0 || limit > MaxSyncLimit {
		limit = DefaultSyncLimit
	}

	delta, err := s.sync.Sync(ctx, vaultID, userID, cursor, limit)
	if err != nil {
		return nil, translate(err, "read changes")
	}

	// The member's access moved after the cursor was issued, so what they can see now is
	// not what the delta describes. Re-reading the whole vault is the only honest answer.
	if member.AccessSeq > cursor {
		delta.FullResync = true
	}

	return delta, nil
}
