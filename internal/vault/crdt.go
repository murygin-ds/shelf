package vault

import (
	"context"
	"errors"
	"time"
)

// Live editing errors.
var (
	// ErrEpochMismatch means an update was written against a document that has since been
	// replaced — by a body written around the CRDT, or by a re-key. Merging it would apply
	// an edit to text it was never written against, so the client re-seeds instead.
	ErrEpochMismatch = errors.New("this document has been replaced")
	// ErrCompactRequired means the log has grown past what the server will hold without a
	// snapshot. Only a client can compact it: merging updates needs the key.
	ErrCompactRequired = errors.New("the update log needs to be compacted")
	// ErrUpdateTooLarge means a single update is past the ceiling one batch may carry.
	ErrUpdateTooLarge = errors.New("an update is too large")
)

// Growth ceilings on one document's log. The server cannot merge ciphertext, so these are
// the only limits it can enforce without reading anything.
const (
	MaxPendingUpdates = 2000
	MaxPendingBytes   = 4 * 1024 * 1024
	MaxUpdateBytes    = 256 * 1024
	MaxSnapshotBytes  = 8 * 1024 * 1024
)

// CRDTDoc is the live document behind a note: what the editors merge into and what the
// server stores without being able to read it.
type CRDTDoc struct {
	FileID     int64
	VaultID    int64
	KeyScopeID int64
	KeyVersion int32
	// Epoch identifies which document this is. A client holding an older one is talking
	// about a document that no longer exists.
	Epoch int32
	// CommittedSeq is the body version the log has been folded into. Behind the note's
	// content_seq means a commit is owed.
	CommittedSeq int64
	// Snapshot is the document state as of SnapshotSeq, sealed under the scope key. Absent
	// on a document nobody has compacted yet.
	Snapshot     *Blob
	SnapshotSeq  int64
	LastSeq      int64
	PendingCount int32
	PendingBytes int64
	CreatedBy    *int64
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// Full reports whether the log has grown past what the server will hold. A full document
// accepts no more updates until a client commits a snapshot and prunes it.
func (d CRDTDoc) Full() bool {
	return d.PendingCount >= MaxPendingUpdates || d.PendingBytes >= MaxPendingBytes
}

// CRDTUpdate is one batch of merged updates as it travels and as it is stored.
type CRDTUpdate struct {
	Seq       int64
	Epoch     int32
	Payload   Blob
	AuthorID  *int64
	Signature []byte
	CreatedAt time.Time
}

// NewCRDTDoc seeds a document from the body a client has just read.
type NewCRDTDoc struct {
	FileID     int64
	Snapshot   Blob
	KeyScopeID int64
	KeyVersion int32
	// ContentSeq is the body version the snapshot was built from. The seed is refused if
	// the body has moved since, because the document would start from text nobody has.
	ContentSeq int64
	Signature  []byte
}

// NewCRDTUpdate is one update on its way into the log.
type NewCRDTUpdate struct {
	FileID     int64
	Epoch      int32
	Payload    Blob
	KeyScopeID int64
	KeyVersion int32
	Signature  []byte
}

// CRDTStore is the storage of live documents.
type CRDTStore interface {
	CRDTDoc(ctx context.Context, fileID int64) (*CRDTDoc, error)
	// SeedCRDTDoc creates the document, or returns the one that already exists. The second
	// result says which of the two happened: the loser of a race has to adopt what it is
	// handed rather than merge its own copy into it.
	SeedCRDTDoc(ctx context.Context, in NewCRDTDoc, actorID int64) (*CRDTDoc, bool, error)
	CRDTUpdates(ctx context.Context, fileID int64, epoch int32, since int64) ([]CRDTUpdate, error)
	AppendCRDTUpdate(ctx context.Context, in NewCRDTUpdate, actorID int64) (*CRDTUpdate, error)
}

// LiveDoc reads the document behind a note for a caller who may at least see it. Readers
// need it too: somebody with view has to watch the edits arrive.
func (s *Service) LiveDoc(ctx context.Context, userID, fileID int64) (*CRDTDoc, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermView); err != nil {
		return nil, err
	}

	doc, err := s.crdt.CRDTDoc(ctx, fileID)
	if err != nil {
		return nil, translate(err, "read live document")
	}

	return doc, nil
}

// LiveUpdates reads the log from a sequence the caller already holds.
func (s *Service) LiveUpdates(
	ctx context.Context,
	userID, fileID int64,
	epoch int32,
	since int64,
) ([]CRDTUpdate, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermView); err != nil {
		return nil, err
	}

	updates, err := s.crdt.CRDTUpdates(ctx, fileID, epoch, since)
	if err != nil {
		return nil, translate(err, "read live updates")
	}

	return updates, nil
}

// SeedLiveDoc starts a document, or hands back the one that was started first.
func (s *Service) SeedLiveDoc(ctx context.Context, userID int64, in NewCRDTDoc) (*CRDTDoc, bool, error) {
	if len(in.Signature) != 0 && len(in.Signature) != SignatureLength {
		return nil, false, ErrSignatureInvalid
	}

	if len(in.Snapshot.Ciphertext) > MaxSnapshotBytes {
		return nil, false, ErrUpdateTooLarge
	}

	ref, err := s.fileFor(ctx, userID, in.FileID, PermEdit)
	if err != nil {
		return nil, false, err
	}

	if err := s.matchesScope(ref, in.KeyScopeID, in.KeyVersion); err != nil {
		return nil, false, err
	}

	doc, seeded, err := s.crdt.SeedCRDTDoc(ctx, in, userID)
	if err != nil {
		return nil, false, translate(err, "seed live document")
	}

	return doc, seeded, nil
}

// AppendLiveUpdate stores one update and hands back the sequence it was given.
//
// Writing needs edit. A reader whose update reached this point is refused here as well as
// on the socket, because the socket check is the server's good behaviour and this one is
// the record.
func (s *Service) AppendLiveUpdate(ctx context.Context, userID int64, in NewCRDTUpdate) (*CRDTUpdate, error) {
	if len(in.Signature) != 0 && len(in.Signature) != SignatureLength {
		return nil, ErrSignatureInvalid
	}

	if len(in.Payload.Ciphertext) > MaxUpdateBytes {
		return nil, ErrUpdateTooLarge
	}

	ref, err := s.fileFor(ctx, userID, in.FileID, PermEdit)
	if err != nil {
		return nil, err
	}

	if err := s.matchesScope(ref, in.KeyScopeID, in.KeyVersion); err != nil {
		return nil, err
	}

	update, err := s.crdt.AppendCRDTUpdate(ctx, in, userID)
	if err != nil {
		return nil, translate(err, "append live update")
	}

	return update, nil
}
