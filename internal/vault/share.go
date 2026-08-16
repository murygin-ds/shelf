package vault

import (
	"context"
	"time"
)

// MaxShareTTL bounds how long a public link may live. A link with no end is a credential
// nobody remembers issuing.
const MaxShareTTL = 90 * 24 * time.Hour

// ShareLink is a read-only public link to one note.
//
// The token never reaches the server — only its digest — the same way sessions and code
// invites already work. What travels with the link is a copy of the note encrypted under a
// key derived from that token, never the note's scope key: a scope covers a whole folder or
// a whole vault, so handing that key out would make one published note the key to
// everything sealed beside it, and revoking the link would not take it back.
//
// The copy is a snapshot of the version that was published. A live link would silently
// publish every future edit, and an edit that has already been served cannot be recalled.
//
// Read-only is not a setting that could be relaxed later: an anonymous writer holds no
// signing key, and an unsigned revision is exactly what author signatures rule out.
type ShareLink struct {
	ID      int64
	FileID  int64
	VaultID int64
	// ContentSeq is the version that was published, so the owner can see whether the link
	// has fallen behind the note.
	ContentSeq   int64
	CreatedBy    *int64
	CreatorName  string
	ExpiresAt    *time.Time
	RevokedAt    *time.Time
	LastViewedAt *time.Time
	ViewCount    int64
	CreatedAt    time.Time
}

// Live reports whether the link would still open right now.
func (s ShareLink) Live() bool {
	if s.RevokedAt != nil {
		return false
	}

	return s.ExpiresAt == nil || s.ExpiresAt.After(time.Now())
}

// NewShareLink opens a link. The client has already re-encrypted the note under a key
// derived from the secret it is about to hand out.
type NewShareLink struct {
	FileID     int64
	TokenHash  []byte
	Meta       Blob
	Content    Blob
	ContentSeq int64
	ExpiresAt  *time.Time
}

// PublicNote is everything an anonymous visitor gets: the published copy and when it was
// taken. No vault, no folder, no author, and nothing that opens anything else.
type PublicNote struct {
	ClientID    string
	Meta        Blob
	Content     Blob
	PublishedAt time.Time
}

// ShareRepository stores public links.
type ShareRepository interface {
	CreateShareLink(ctx context.Context, in NewShareLink, actorID int64) (*ShareLink, error)
	ShareLinks(ctx context.Context, fileID int64) ([]ShareLink, error)
	// ShareLink reads one link so the service can authorize against the note behind it.
	ShareLink(ctx context.Context, linkID int64) (*ShareLink, error)
	RevokeShareLink(ctx context.Context, linkID, actorID int64) error
	// PublicNote resolves a link for an anonymous caller. Every reason it might fail —
	// wrong token, expired, revoked, note deleted — is one answer, so the endpoint cannot
	// be used to tell live links from dead ones.
	PublicNote(ctx context.Context, tokenHash []byte) (*PublicNote, error)
}

// CreateShareLink publishes a note. Only somebody who can manage the note may: a public
// link outlives the reader who made it and is not a personal decision.
func (s *Service) CreateShareLink(ctx context.Context, userID int64, in NewShareLink) (*ShareLink, error) {
	if _, err := s.fileFor(ctx, userID, in.FileID, PermOwn); err != nil {
		return nil, err
	}

	// A link that has already expired is a link that never worked. Refusing it beats
	// handing back a URL that opens nothing.
	now := time.Now()
	if in.ExpiresAt != nil && !in.ExpiresAt.After(now) {
		return nil, ErrShareExpiry
	}

	if in.ExpiresAt == nil || in.ExpiresAt.After(now.Add(MaxShareTTL)) {
		limit := now.Add(MaxShareTTL)
		in.ExpiresAt = &limit
	}

	created, err := s.shares.CreateShareLink(ctx, in, userID)
	if err != nil {
		return nil, translate(err, "create share link")
	}

	return created, nil
}

func (s *Service) ShareLinks(ctx context.Context, userID, fileID int64) ([]ShareLink, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermOwn); err != nil {
		return nil, err
	}

	links, err := s.shares.ShareLinks(ctx, fileID)
	if err != nil {
		return nil, translate(err, "list share links")
	}

	return links, nil
}

// RevokeShareLink closes a link.
//
// Authorization runs against the note, and a caller who can see the note but not manage it
// gets the same answer as one who cannot see it at all: a link id is not a handle on
// anything they could otherwise reach, so 403 would only confirm the link exists.
func (s *Service) RevokeShareLink(ctx context.Context, userID, linkID int64) error {
	link, err := s.shares.ShareLink(ctx, linkID)
	if err != nil {
		return translate(err, "read share link")
	}

	if _, err := s.fileFor(ctx, userID, link.FileID, PermOwn); err != nil {
		return ErrNotFound
	}

	if err := s.shares.RevokeShareLink(ctx, linkID, userID); err != nil {
		return translate(err, "revoke share link")
	}

	return nil
}

// PublicNote resolves a link with no account behind it.
func (s *Service) PublicNote(ctx context.Context, tokenHash []byte) (*PublicNote, error) {
	found, err := s.shares.PublicNote(ctx, tokenHash)
	if err != nil {
		return nil, translate(err, "resolve share link")
	}

	return found, nil
}
