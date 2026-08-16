package vault

import (
	"context"
	"time"
)

// SignatureLength is a raw ECDSA P-256 signature, r||s. WebCrypto produces this form
// directly; DER would be the other convention and mixing the two silently fails to verify.
const SignatureLength = 64

// RevisionCoalesce folds saves made close together by the same author into one entry.
// Without it an autosaving editor writes a revision every couple of seconds and the
// history becomes a list nobody can read.
const RevisionCoalesce = 5 * time.Minute

// DefaultRevisionLimit is one screen of history.
const DefaultRevisionLimit = 50

// MaxRevisionLimit bounds one page.
const MaxRevisionLimit = 200

// Revision is one stored version of a note body.
//
// It keeps its own key scope and version because a re-key rewrites the current row and
// leaves history alone: dropping them would make every revision written before the first
// rotation unreadable.
type Revision struct {
	ID         int64
	FileID     int64
	VaultID    int64
	KeyScopeID int64
	// KeyScopeClientID names the scope inside the additional data, so a reader can rebuild
	// it without guessing which scope held the note at the time.
	KeyScopeClientID string
	KeyVersion       int32
	// Content is empty in a listing. Bodies are fetched one revision at a time.
	Content     Blob
	ContentSize int
	ContentSeq  int64
	AuthorID    *int64
	AuthorLogin string
	AuthorName  string
	// AuthorPublicKey is the blob the signature verifies against. It travels with the
	// revision so a reader never has to trust a separate lookup to decide who wrote it.
	AuthorPublicKey []byte
	Signature       []byte
	CreatedAt       time.Time
}

// Signed reports whether the revision carries an author signature at all. An unsigned
// revision is not proof of anything: view, comment and edit are the same key, so any
// reader can produce ciphertext that decrypts.
func (r Revision) Signed() bool { return len(r.Signature) == SignatureLength }

// RevisionRepository reads the history of note bodies.
type RevisionRepository interface {
	Revisions(ctx context.Context, fileID, userID int64, limit int) ([]Revision, error)
	Revision(ctx context.Context, revisionID, userID int64) (*Revision, error)
}

// Revisions lists the history of a note, newest first, without the bodies.
func (s *Service) Revisions(ctx context.Context, userID, fileID int64, limit int) ([]Revision, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermView); err != nil {
		return nil, err
	}

	switch {
	case limit <= 0:
		limit = DefaultRevisionLimit
	case limit > MaxRevisionLimit:
		limit = MaxRevisionLimit
	}

	list, err := s.revisions.Revisions(ctx, fileID, userID, limit)
	if err != nil {
		return nil, translate(err, "read revisions")
	}

	return list, nil
}

// Revision reads one stored body. Authorization runs against the note it belongs to, so a
// revision id is no more of an oracle than the note id already is.
func (s *Service) Revision(ctx context.Context, userID, revisionID int64) (*Revision, error) {
	found, err := s.revisions.Revision(ctx, revisionID, userID)
	if err != nil {
		return nil, translate(err, "read revision")
	}

	return found, nil
}
