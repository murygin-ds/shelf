package mcp

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"shelf/internal/envelope"
	"shelf/internal/vault"
)

// CreateFolder makes a folder, and every folder above it that does not exist yet.
//
// Creating the whole path rather than refusing a missing parent is deliberate: the tools are
// driven by a model working from a path it read a moment ago, and making it walk the tree
// down one level at a time buys nothing but round trips.
func (w *Workspace) CreateFolder(ctx context.Context, path string) (*Node, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	segments, err := split(path)
	if err != nil {
		return nil, err
	}

	// Checked before anything is written. Creation walks the path one level at a time, so a
	// depth the tree will refuse halfway leaves the levels above it behind — the call fails
	// and the vault changed anyway.
	if len(segments) > MaxDepth {
		return nil, fmt.Errorf("%w: %d levels, the tree holds %d", ErrPath, len(segments), MaxDepth)
	}

	if taken := built.notes[clean(path)]; taken != nil {
		return nil, fmt.Errorf("%w: %s is a note", ErrPath, clean(path))
	}

	var (
		at      string
		current *folderAt
	)

	for _, segment := range segments {
		at = join(at, segment)

		if existing, ok := built.folders[at]; ok {
			if existing.node.Locked {
				return nil, ErrLocked
			}

			current = existing

			continue
		}

		created, err := w.folder(ctx, segment, current)
		if err != nil {
			return nil, err
		}

		current = created
		built.folders[at] = created
	}

	if current == nil {
		return nil, fmt.Errorf("%w: %s", ErrPath, path)
	}

	return &current.node, nil
}

// CreateNote writes a new note, creating the folders on the way to it.
func (w *Workspace) CreateNote(ctx context.Context, path, body string) (*Note, error) {
	if len(body) > MaxBodyBytes {
		return nil, fmt.Errorf("%w: %d bytes, the ceiling is %d", ErrTooLarge, len(body), MaxBodyBytes)
	}

	segments, err := split(path)
	if err != nil {
		return nil, err
	}

	name := segments[len(segments)-1]
	parentPath := strings.Join(segments[:len(segments)-1], "/")

	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	if _, taken := built.notes[clean(path)]; taken {
		return nil, fmt.Errorf("%w: %s already exists", ErrPath, clean(path))
	}

	// One namespace for both kinds, because a path is the only address these tools have.
	if _, taken := built.folders[clean(path)]; taken {
		return nil, fmt.Errorf("%w: %s is a folder", ErrPath, clean(path))
	}

	var parent *folderAt

	if parentPath != "" {
		if _, err := w.CreateFolder(ctx, parentPath); err != nil {
			return nil, err
		}

		// Re-read: the folders were created since the tree above was taken.
		built, err = w.read(ctx)
		if err != nil {
			return nil, err
		}

		found, ok := built.folders[parentPath]
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrPath, parentPath)
		}

		parent = found
	}

	at := w.destination(parent)

	clientID := newClientID()

	key := w.ring.Get(at.id, at.version)
	if key == nil {
		return nil, ErrLocked
	}

	ref := envelope.EntityRef{
		VaultID:       w.vaultID,
		Entity:        envelope.EntityFile,
		EntityID:      clientID,
		ScopeClientID: at.clientID,
		KeyVersion:    at.version,
	}

	meta, err := envelope.EncryptMeta(key, envelope.Meta{Name: name}, ref)
	if err != nil {
		return nil, fmt.Errorf("seal note metadata: %w", err)
	}

	// Created empty and written afterwards, the way the browser does it: the body write is
	// the one that carries a signature, and a note that arrived with its text unsigned would
	// be indistinguishable from one the server made up.
	empty, err := envelope.EncryptContent(key, "", ref)
	if err != nil {
		return nil, fmt.Errorf("seal an empty body: %w", err)
	}

	var folderID *int64
	if parent != nil {
		folderID = &parent.folder.ID
	}

	file, err := w.vaults.CreateFile(ctx, w.userID, vault.NewFile{
		ClientID:   clientID,
		VaultID:    w.vaultID,
		FolderID:   folderID,
		Meta:       vault.Blob{Ciphertext: meta.Ciphertext, Nonce: meta.Nonce},
		Content:    vault.Blob{Ciphertext: empty.Ciphertext, Nonce: empty.Nonce},
		KeyScopeID: at.id,
		KeyVersion: at.version,
	})
	if err != nil {
		return nil, err
	}

	if body == "" {
		return &Note{Node: w.noteNode(*file, name, join(parentPath, name)), Body: ""}, nil
	}

	return w.write(ctx, *file, join(parentPath, name), name, body)
}

// WriteNote replaces a body under the optimistic lock the caller read.
func (w *Workspace) WriteNote(ctx context.Context, path, body string, expectedSeq int64) (*Note, error) {
	if len(body) > MaxBodyBytes {
		return nil, fmt.Errorf("%w: %d bytes, the ceiling is %d", ErrTooLarge, len(body), MaxBodyBytes)
	}

	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	at, err := built.note(path)
	if err != nil {
		return nil, err
	}

	// Exact, with no value that means "whatever it is now". A caller that does not hold a
	// sequence has not read the note, and letting zero through would turn the one guard
	// against overwriting somebody into an opt-in.
	if expectedSeq != at.file.ContentSeq {
		return nil, fmt.Errorf("%w: the note is at %d, you read %d",
			vault.ErrVersionConflict, at.file.ContentSeq, expectedSeq)
	}

	return w.write(ctx, at.file, at.node.Path, at.node.Name, body)
}

// AppendNote adds to the end of a note. Read and write in one call, because a model asked to
// append should not have to hold a sequence number across two of them.
func (w *Workspace) AppendNote(ctx context.Context, path, text string) (*Note, error) {
	note, err := w.ReadNote(ctx, path)
	if err != nil {
		return nil, err
	}

	body := note.Body
	if body != "" && !strings.HasSuffix(body, "\n") {
		body += "\n"
	}

	return w.WriteNote(ctx, path, body+text, note.ContentSeq)
}

// MoveNote puts a note under another folder, creating it if it is missing.
func (w *Workspace) MoveNote(ctx context.Context, path, folder string) (*Node, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	at, err := built.note(path)
	if err != nil {
		return nil, err
	}

	var parent *int64

	if clean(folder) != "" {
		destination, err := w.CreateFolder(ctx, folder)
		if err != nil {
			return nil, err
		}

		parent = &destination.ID
	}

	moved, err := w.vaults.MoveFile(ctx, w.userID, at.file.ID, vault.Move{ParentID: parent})
	if err != nil {
		return nil, err
	}

	node := w.noteNode(*moved, at.node.Name, join(clean(folder), at.node.Name))

	return &node, nil
}

// TrashNote puts a note in the trash. Purging is not offered at all: it destroys ciphertext
// nothing brings back, and that is not a decision to hand to a tool call.
func (w *Workspace) TrashNote(ctx context.Context, path string) error {
	built, err := w.read(ctx)
	if err != nil {
		return err
	}

	at, err := built.note(path)
	if err != nil {
		return err
	}

	return w.vaults.DeleteFile(ctx, w.userID, at.file.ID)
}

// write seals and stores a body, signed as the connector.
func (w *Workspace) write(ctx context.Context, file vault.File, path, name, body string) (*Note, error) {
	// A body written without a document to speak for it invalidates the live one, dropping
	// whatever the person at the keyboard has not committed yet. Refusing is the only
	// answer that does not throw away somebody's sentence mid-word.
	if w.live != nil && w.live.Editing(file.ID) {
		return nil, fmt.Errorf("%w: %s", ErrBusy, path)
	}

	key := w.ring.Get(file.KeyScopeID, file.KeyVersion)
	if key == nil {
		return nil, ErrLocked
	}

	ref := w.fileRef(file)

	sealed, err := envelope.EncryptContent(key, body, ref)
	if err != nil {
		return nil, fmt.Errorf("seal the body: %w", err)
	}

	// The sequence the write will land on is one past what we read, and it is inside the
	// digest: without it an old body could be replayed as the current one.
	next := file.ContentSeq + 1

	signature, err := envelope.SignRevision(w.identity, ref, next,
		envelope.Sealed{Ciphertext: sealed.Ciphertext, Nonce: sealed.Nonce})
	if err != nil {
		return nil, err
	}

	updated, err := w.vaults.UpdateContent(ctx, w.userID, file.ID, vault.ContentUpdate{
		Content:     vault.Blob{Ciphertext: sealed.Ciphertext, Nonce: sealed.Nonce},
		ExpectedSeq: file.ContentSeq,
		KeyScopeID:  file.KeyScopeID,
		KeyVersion:  file.KeyVersion,
		Signature:   signature,
	})
	if err != nil {
		return nil, err
	}

	return &Note{Node: w.noteNode(*updated, name, path), Body: body}, nil
}

// folder creates one level and returns it indexed, so a caller walking a path can carry on.
func (w *Workspace) folder(ctx context.Context, name string, parent *folderAt) (*folderAt, error) {
	at := w.destination(parent)

	clientID := newClientID()

	key := w.ring.Get(at.id, at.version)
	if key == nil {
		return nil, ErrLocked
	}

	meta, err := envelope.EncryptMeta(key, envelope.Meta{Name: name}, envelope.EntityRef{
		VaultID:       w.vaultID,
		Entity:        envelope.EntityFolder,
		EntityID:      clientID,
		ScopeClientID: at.clientID,
		KeyVersion:    at.version,
	})
	if err != nil {
		return nil, fmt.Errorf("seal folder metadata: %w", err)
	}

	var parentID *int64

	path := name

	if parent != nil {
		parentID = &parent.folder.ID
		path = join(parent.node.Path, name)
	}

	created, err := w.vaults.CreateFolder(ctx, w.userID, vault.NewFolder{
		ClientID:   clientID,
		VaultID:    w.vaultID,
		ParentID:   parentID,
		Meta:       vault.Blob{Ciphertext: meta.Ciphertext, Nonce: meta.Nonce},
		KeyScopeID: at.id,
		KeyVersion: at.version,
	})
	if err != nil {
		return nil, err
	}

	return &folderAt{
		folder: *created,
		node: Node{
			ID:        created.ID,
			Kind:      KindFolder,
			Path:      path,
			Name:      name,
			UpdatedAt: created.UpdatedAt,
		},
	}, nil
}

// destination is the scope a write into this parent has to be sealed under. Sending any
// other is refused by the service, because the row would be unreadable where it landed.
func (w *Workspace) destination(parent *folderAt) scope {
	if parent == nil {
		return w.root
	}

	return scope{
		id:       parent.folder.KeyScopeID,
		clientID: parent.folder.KeyScopeClientID,
		version:  parent.folder.KeyVersion,
	}
}

func (w *Workspace) noteNode(file vault.File, name, path string) Node {
	return Node{
		ID:         file.ID,
		Kind:       KindNote,
		Path:       path,
		Name:       name,
		ContentSeq: file.ContentSeq,
		UpdatedAt:  file.UpdatedAt,
	}
}

// split breaks a path into the segments a tree walk needs, refusing what cannot be a name.
func split(path string) ([]string, error) {
	cleaned := clean(path)
	if cleaned == "" {
		return nil, fmt.Errorf("%w: an empty path", ErrPath)
	}

	segments := strings.Split(cleaned, "/")

	for _, segment := range segments {
		if strings.TrimSpace(segment) == "" {
			return nil, fmt.Errorf("%w: %q has an empty segment", ErrPath, path)
		}

		if segment == "." || segment == ".." {
			return nil, fmt.Errorf("%w: %q is not a name", ErrPath, segment)
		}

		// Names are sealed metadata, so the server cannot bound them where it bounds
		// everything else — the DTO cap the browser meets never runs on this path. Bounded
		// here instead, at the same length the archive format allows.
		if len(segment) > MaxNameBytes {
			return nil, fmt.Errorf("%w: a name may be at most %d bytes", ErrPath, MaxNameBytes)
		}

		if bad, found := unrenderable(segment); found {
			return nil, fmt.Errorf("%w: a name may not contain %q", ErrPath, bad)
		}
	}

	return segments, nil
}

// unrenderable finds a character that would make a name display as something other than what
// it is.
//
// A person naming their own note is their own business. A connector is not: it writes names
// a person then reads in a list, and a right-to-left override turns "gnp.exe" into what looks
// like a picture. Control characters do the same to a line of a terminal or a log.
func unrenderable(segment string) (rune, bool) {
	for _, r := range segment {
		switch {
		case r == '\t':
			continue
		case unicode.IsControl(r):
			return r, true
		// The bidi overrides and isolates, which reorder what follows them.
		case r >= 0x202A && r <= 0x202E, r >= 0x2066 && r <= 0x2069:
			return r, true
		// A zero-width character makes two different names look identical.
		case r == 0x200B, r == 0x200C, r == 0x200D, r == 0xFEFF:
			return r, true
		}
	}

	return 0, false
}
