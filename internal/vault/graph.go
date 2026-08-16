package vault

import "context"

// MaxLinksPerNote bounds one link write. A note with more outgoing links than this is
// almost certainly a generated index, and the graph stops being readable long before.
const MaxLinksPerNote = 500

// Link is one directed reference between two notes.
//
// It carries ids and nothing else. A [[wikilink]] is written as a title, titles are
// encrypted, and only a reader holding the key can turn one into a note — so the server
// stores what some reader already resolved and can neither verify nor reproduce it. Two
// readers with different access will disagree about which links exist, and each is right
// about their own slice.
type Link struct {
	From int64
	To   int64
}

// GraphNode is one note in the graph.
//
// A node the caller cannot open carries no id: it is identified only by its position in
// this response. Handing out the real id would make the graph an existence oracle for
// notes every other route answers 404 for.
type GraphNode struct {
	// Ref names the node inside this response only. Visible nodes use their file id as a
	// string; locked ones use an opaque counter.
	Ref string
	// FileID is zero for a locked node.
	FileID           int64
	ClientID         string
	FolderID         *int64
	KeyScopeID       int64
	KeyScopeClientID string
	KeyVersion       int32
	Meta             *Blob
	Locked           bool
	Degree           int
}

// GraphEdge joins two nodes by their in-response refs.
type GraphEdge struct {
	From string
	To   string
}

// Graph is the whole link structure of a vault as one caller sees it.
type Graph struct {
	Nodes []GraphNode
	Edges []GraphEdge
	// Locked counts the nodes in Nodes the caller cannot open. Zero when the vault has
	// masked nodes turned off, in which case their edges are gone as well.
	Locked int
	// RevealsLocked repeats the vault's setting, so the view can say whether the picture
	// is the whole graph or only the part this caller can read.
	RevealsLocked bool
}

// Backlinks is what points at one note.
type Backlinks struct {
	Visible []File
	// Hidden counts the notes that link here and that the caller cannot see. It is a
	// count and never a list: the count is the honest part, the identities are not the
	// caller's to have.
	Hidden int
}

// GraphRepository stores and resolves note links.
type GraphRepository interface {
	// ReplaceLinks makes the note's outgoing links exactly the given set. Targets the
	// author cannot see are dropped: a link nobody could have resolved is a link somebody
	// guessed.
	ReplaceLinks(ctx context.Context, fileID, userID int64, to []int64) error
	Backlinks(ctx context.Context, fileID, userID int64) (*Backlinks, error)
	Graph(ctx context.Context, vaultID, userID int64) (*Graph, error)
}

// SetLinks records what a note points at. The caller must be able to edit the note, and
// every target is filtered against what the caller can see.
func (s *Service) SetLinks(ctx context.Context, userID, fileID int64, to []int64) error {
	if len(to) > MaxLinksPerNote {
		return ErrLinkBatch
	}

	if _, err := s.fileFor(ctx, userID, fileID, PermEdit); err != nil {
		return err
	}

	if err := s.graph.ReplaceLinks(ctx, fileID, userID, to); err != nil {
		return translate(err, "replace links")
	}

	return nil
}

// Backlinks lists what points at a note, and counts what points at it out of sight.
func (s *Service) Backlinks(ctx context.Context, userID, fileID int64) (*Backlinks, error) {
	if _, err := s.fileFor(ctx, userID, fileID, PermView); err != nil {
		return nil, err
	}

	found, err := s.graph.Backlinks(ctx, fileID, userID)
	if err != nil {
		return nil, translate(err, "read backlinks")
	}

	return found, nil
}

// Graph draws the vault as this caller sees it.
func (s *Service) Graph(ctx context.Context, userID, vaultID int64) (*Graph, error) {
	if _, err := s.member(ctx, vaultID, userID); err != nil {
		return nil, err
	}

	graph, err := s.graph.Graph(ctx, vaultID, userID)
	if err != nil {
		return nil, translate(err, "read graph")
	}

	return graph, nil
}
