package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"shelf/internal/envelope"
	"shelf/internal/vault"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// MaxBodyBytes is the largest note body that still fits the ciphertext ceiling once it has
// been framed, padded to a block and given its authentication tag. Kept identical to the
// bound the browser uses, so a note Claude writes is one a person could have written.
const MaxBodyBytes = 4*1024*1024 - envelope.PadBlock - 16

// MaxTags and MaxTagBytes bound what may be attached to a note. The browser meets the same
// bounds when it writes a tag; a connector calls the domain directly, so it meets them here.
const (
	MaxTags     = 24
	MaxTagBytes = 64
)

// MaxNameBytes bounds a folder or note name. The browser meets this bound in the request
// DTO; a connector calls the domain directly, so it has to meet it here.
const MaxNameBytes = 200

// MaxDepth is the depth the folder tree accepts. Checked before a path is created rather
// than discovered partway down it.
const MaxDepth = 32

// Locked is the name given to a node whose key this connector does not hold. It is a state
// rather than an error: a folder given its own key is simply outside what Claude may see,
// and the tree says so instead of failing.
const Locked = "(locked)"

var (
	// ErrBusy refuses a write to a note somebody is editing right now.
	ErrBusy = errors.New("the note is being edited right now")
	// ErrUnsettled refuses a write to a note whose live document holds edits its body does
	// not. Nobody is in the room — the session ended without writing back — so the body on
	// disk is behind text that still exists, and a write from here would drop it.
	ErrUnsettled = errors.New("the note has edits that have not been written to its body yet")
	// ErrTooLarge refuses a body that would not fit.
	ErrTooLarge = errors.New("the body is too large")
	// ErrPath reports a path that names nothing, or names the wrong kind of thing.
	ErrPath = errors.New("no such path")
	// ErrLocked reports a node this connector holds no key for.
	ErrLocked = errors.New("this connector holds no key for that")
	// ErrNotEmpty refuses to trash a folder that still holds something.
	ErrNotEmpty = errors.New("the folder is not empty")
	// ErrTag rejects a tag the rest of the system would not accept.
	ErrTag = errors.New("that is not a usable tag")
)

// Vaults is the slice of the vault service a connector drives. Every call goes through it
// with the connector's own user id, so the permission model, the optimistic lock and the
// 404-instead-of-403 rule apply to Claude exactly as they do to a person.
type Vaults interface {
	Vaults(ctx context.Context, userID int64) ([]vault.Summary, error)
	Tree(ctx context.Context, userID, vaultID int64) ([]vault.Folder, []vault.File, error)
	File(ctx context.Context, userID, fileID int64) (*vault.File, error)
	CreateFolder(ctx context.Context, userID int64, in vault.NewFolder) (*vault.Folder, error)
	Files(ctx context.Context, userID, vaultID int64, ids []int64) ([]vault.File, error)
	Trash(ctx context.Context, userID, vaultID int64) ([]vault.Folder, []vault.File, error)
	CreateFile(ctx context.Context, userID int64, in vault.NewFile) (*vault.File, error)
	UpdateFile(ctx context.Context, userID, fileID int64, in vault.MetaUpdate) (*vault.File, error)
	UpdateFolder(ctx context.Context, userID, folderID int64, in vault.MetaUpdate) (*vault.Folder, error)
	DeleteFolder(ctx context.Context, userID, folderID int64) error
	RestoreFile(ctx context.Context, userID, fileID int64) error
	RestoreFolder(ctx context.Context, userID, folderID int64) error
	UpdateContent(ctx context.Context, userID, fileID int64, in vault.ContentUpdate) (*vault.File, error)
	LiveDoc(ctx context.Context, userID, fileID int64) (*vault.CRDTDoc, error)
	SetLinks(ctx context.Context, userID, fileID int64, to []int64) error
	MoveFile(ctx context.Context, userID, fileID int64, in vault.Move) (*vault.File, error)
	DeleteFile(ctx context.Context, userID, fileID int64) error
}

// Live reports whether a note is open in an editing session right now.
//
// A body written from here without a document to speak for it invalidates the live one: the
// epoch rises and the pending updates are dropped, which is correct for an offline replay
// and looks like Claude deleting somebody's paragraph when it happens mid-sentence. So the
// write refuses instead.
type Live interface {
	Editing(fileID int64) bool
}

// Node is a folder or a note as Claude sees it.
type Node struct {
	ID   int64
	Kind string
	Path string
	Name string
	Icon string
	Tags []string
	// Locked marks a node this connector cannot open. Its children are listed too, because
	// their ids still work even when their names do not.
	Locked bool
	// ContentSeq is the optimistic lock a write has to carry. Notes only.
	ContentSeq int64
	UpdatedAt  time.Time
}

// Note is a node together with its body.
type Note struct {
	Node
	Body string
	// PendingEdits marks a body the live document has moved past: somebody typed, the
	// session ended before it wrote back, and what is here is the last version that landed.
	// Reading it is fine; writing over it is what ErrUnsettled refuses.
	PendingEdits bool
}

// Trashed is something in the bin, addressed by an id rather than a path.
//
// A path is the address everywhere else here, but it is not one for a trashed note: the
// place it names may hold a live note now, and restoring by path would be a guess.
type Trashed struct {
	ID        int64
	Kind      string
	Name      string
	Path      string
	TrashedAt time.Time
}

// Hit is one search result.
type Hit struct {
	Node
	Snippet string
}

// The two kinds a node can be, as they appear in tool output.
const (
	KindFolder = "folder"
	KindNote   = "note"
)

// Workspace is one connected vault, opened.
//
// It is built per request and thrown away: the plaintext it produces lives no longer than
// the call that asked for it, and a connector removed a moment ago cannot be served from
// something that was opened before.
type Workspace struct {
	vaults   Vaults
	live     Live
	log      *zap.Logger
	ring     *Keyring
	identity *envelope.Identity
	userID   int64
	vaultID  int64
	root     scope
}

type scope struct {
	id       int64
	clientID string
	version  int32
}

// Open prepares a workspace over a vault the connector has been admitted to.
//
// The logger is optional, and only a write that stored a body but not its links has anything
// to say through it.
func Open(
	ctx context.Context,
	vaults Vaults,
	live Live,
	log *zap.Logger,
	ring *Keyring,
	identity *envelope.Identity,
	connector *Connector,
) (*Workspace, error) {
	if log == nil {
		log = zap.NewNop()
	}

	summaries, err := vaults.Vaults(ctx, connector.UserID)
	if err != nil {
		return nil, fmt.Errorf("read vaults: %w", err)
	}

	for _, summary := range summaries {
		if summary.ID != connector.VaultID {
			continue
		}

		return &Workspace{
			vaults:   vaults,
			live:     live,
			log:      log,
			ring:     ring,
			identity: identity,
			userID:   connector.UserID,
			vaultID:  connector.VaultID,
			root: scope{
				id:       summary.KeyScopeID,
				clientID: summary.KeyScopeClientID,
				version:  summary.KeyVersion,
			},
		}, nil
	}

	// The membership is gone, which is what disabling a connector does.
	return nil, vault.ErrNotFound
}

// tree is the decrypted shape of the vault, indexed for path lookups.
type tree struct {
	nodes   []Node
	folders map[string]*folderAt
	notes   map[string]*noteAt
	byID    map[int64]*Node
}

type folderAt struct {
	folder vault.Folder
	node   Node
}

type noteAt struct {
	file vault.File
	node Node
}

// read decrypts the whole vault and builds the paths.
//
// Whole rather than partial because a path is only meaningful against the entire tree: a
// note's path is the names of its ancestors, and one locked folder in the middle changes
// what every node beneath it is called.
func (w *Workspace) read(ctx context.Context) (*tree, error) {
	folders, files, err := w.vaults.Tree(ctx, w.userID, w.vaultID)
	if err != nil {
		return nil, fmt.Errorf("read tree: %w", err)
	}

	built := &tree{
		folders: make(map[string]*folderAt, len(folders)),
		notes:   make(map[string]*noteAt, len(files)),
		byID:    make(map[int64]*Node, len(folders)+len(files)),
	}

	names := make(map[int64]string, len(folders))
	locked := make(map[int64]bool, len(folders))
	parents := make(map[int64]*int64, len(folders))
	metas := make(map[int64]envelope.Meta, len(folders))

	for _, folder := range folders {
		meta, err := w.openMeta(folder.KeyScopeID, folder.KeyVersion, folder.Meta, envelope.EntityRef{
			VaultID:       w.vaultID,
			Entity:        envelope.EntityFolder,
			EntityID:      folder.ClientID,
			ScopeClientID: folder.KeyScopeClientID,
			KeyVersion:    folder.KeyVersion,
		})

		names[folder.ID] = meta.Name
		locked[folder.ID] = err != nil
		parents[folder.ID] = folder.ParentID
		metas[folder.ID] = meta

		if err != nil {
			names[folder.ID] = Locked
		}
	}

	// Shallowest first, so a parent's path is always known before its children ask for it.
	sort.SliceStable(folders, func(i, j int) bool { return folders[i].Depth < folders[j].Depth })

	paths := make(map[int64]string, len(folders))

	for _, folder := range folders {
		path := join(parentPath(paths, folder.ParentID), names[folder.ID])
		paths[folder.ID] = path

		node := Node{
			ID:        folder.ID,
			Kind:      KindFolder,
			Path:      path,
			Name:      names[folder.ID],
			Icon:      metas[folder.ID].Icon,
			Tags:      metas[folder.ID].Tags,
			Locked:    locked[folder.ID],
			UpdatedAt: folder.UpdatedAt,
		}

		built.nodes = append(built.nodes, node)
		built.folders[path] = &folderAt{folder: folder, node: node}
	}

	for _, file := range files {
		meta, err := w.openMeta(file.KeyScopeID, file.KeyVersion, file.Meta, w.fileRef(file))

		name := meta.Name
		if err != nil {
			name = Locked
		}

		path := join(parentPath(paths, file.FolderID), name)

		node := Node{
			ID:         file.ID,
			Kind:       KindNote,
			Path:       path,
			Name:       name,
			Icon:       meta.Icon,
			Tags:       meta.Tags,
			Locked:     err != nil,
			ContentSeq: file.ContentSeq,
			UpdatedAt:  file.UpdatedAt,
		}

		built.nodes = append(built.nodes, node)
		built.notes[path] = &noteAt{file: file, node: node}
	}

	for i := range built.nodes {
		built.byID[built.nodes[i].ID] = &built.nodes[i]
	}

	sort.SliceStable(built.nodes, func(i, j int) bool { return built.nodes[i].Path < built.nodes[j].Path })

	return built, nil
}

// Tree lists the vault, optionally from one folder down.
func (w *Workspace) Tree(ctx context.Context, under string) ([]Node, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	under = clean(under)
	if under == "" {
		return built.nodes, nil
	}

	if _, ok := built.folders[under]; !ok {
		return nil, fmt.Errorf("%w: %s", ErrPath, under)
	}

	prefix := under + "/"
	out := make([]Node, 0, len(built.nodes))

	for _, node := range built.nodes {
		if strings.HasPrefix(node.Path, prefix) {
			out = append(out, node)
		}
	}

	return out, nil
}

// bulkFiles matches the ceiling the bulk endpoint validates. Asking for more is refused
// rather than truncated, so the batches are cut here.
const bulkFiles = 200

// ReadNote returns a note's body.
//
// The tree does not carry bodies — it is kept cheap on purpose — so the body is fetched by
// the read that does.
func (w *Workspace) ReadNote(ctx context.Context, path string) (*Note, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	at, err := built.note(path)
	if err != nil {
		return nil, err
	}

	file, err := w.vaults.File(ctx, w.userID, at.file.ID)
	if err != nil {
		return nil, err
	}

	body, err := w.openBody(*file)
	if err != nil {
		return nil, err
	}

	pending, err := w.pending(ctx, at.file.ID)
	if err != nil {
		return nil, err
	}

	node := at.node
	node.ContentSeq = file.ContentSeq

	return &Note{Node: node, Body: body, PendingEdits: pending}, nil
}

// pending reports edits the live document holds and the body does not.
//
// The log is what the room has accumulated since the last write-back, so anything in it is
// text that exists and this body does not carry. A note nobody has ever opened in an editor
// has no document at all, which is the common case and not a failure.
func (w *Workspace) pending(ctx context.Context, fileID int64) (bool, error) {
	doc, err := w.vaults.LiveDoc(ctx, w.userID, fileID)

	switch {
	case errors.Is(err, vault.ErrNotFound):
		return false, nil

	case err != nil:
		return false, fmt.Errorf("read live document: %w", err)
	}

	return doc.PendingCount > 0, nil
}

// bodies hydrates the notes named, in batches the bulk read accepts.
func (w *Workspace) bodies(ctx context.Context, ids []int64) (map[int64]vault.File, error) {
	out := make(map[int64]vault.File, len(ids))

	for start := 0; start < len(ids); start += bulkFiles {
		batch := ids[start:min(start+bulkFiles, len(ids))]

		files, err := w.vaults.Files(ctx, w.userID, w.vaultID, batch)
		if err != nil {
			return nil, fmt.Errorf("read bodies: %w", err)
		}

		for _, file := range files {
			out[file.ID] = file
		}
	}

	return out, nil
}

// Query narrows a search. Every field is optional on its own, but at least one of Text and
// Tag has to be given: listing the vault is what the tree is for.
type Query struct {
	Text string
	// Under restricts the search to a subtree, which is both a filter and the only way to
	// keep the cost of a search proportional to what is being asked about.
	Under string
	Tag   string
}

// Search looks through the bodies, the names and the tags. It decrypts what it searches,
// which is the only way: the index the browser keeps lives in a tab this server has no
// access to, and there is nothing on disk to search that is not ciphertext.
func (w *Workspace) Search(ctx context.Context, query Query, limit int) ([]Hit, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	needle := strings.ToLower(strings.TrimSpace(query.Text))
	tag := strings.ToLower(strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(query.Tag), "#")))

	if needle == "" && tag == "" {
		return nil, fmt.Errorf("%w: give something to search for, or a tag", ErrPath)
	}

	under := clean(query.Under)
	if under != "" {
		if _, ok := built.folders[under]; !ok {
			return nil, fmt.Errorf("%w: %s", ErrPath, under)
		}
	}

	paths := sortedKeys(built.notes)

	if under != "" {
		prefix := under + "/"
		within := paths[:0:0]

		for _, path := range paths {
			if strings.HasPrefix(path, prefix) {
				within = append(within, path)
			}
		}

		paths = within
	}

	// The tag lives in the metadata the tree already carries, so filtering on it costs
	// nothing and spares opening the bodies that could not match.
	if tag != "" {
		tagged := paths[:0:0]

		for _, path := range paths {
			if hasTag(built.notes[path].node.Tags, tag) {
				tagged = append(tagged, path)
			}
		}

		paths = tagged
	}

	ids := make([]int64, 0, len(paths))
	for _, path := range paths {
		if !built.notes[path].node.Locked {
			ids = append(ids, built.notes[path].file.ID)
		}
	}

	// One pass over the vault: the index a browser keeps lives in a tab this server cannot
	// reach, so there is nothing to search that is not fetched and opened first.
	loaded, err := w.bodies(ctx, ids)
	if err != nil {
		return nil, err
	}

	hits := make([]Hit, 0, limit)

	for _, path := range paths {
		if len(hits) >= limit {
			break
		}

		at := built.notes[path]

		if at.node.Locked {
			continue
		}

		file, ok := loaded[at.file.ID]
		if !ok {
			continue
		}

		body, err := w.openBody(file)
		if err != nil {
			continue
		}

		// With no text to look for, matching the tag or the subtree is the whole query.
		if needle == "" {
			hits = append(hits, Hit{Node: at.node, Snippet: first(body)})

			continue
		}

		snippet, found := excerpt(body, needle)

		switch {
		case found:
			hits = append(hits, Hit{Node: at.node, Snippet: snippet})
		case strings.Contains(strings.ToLower(at.node.Name), needle):
			hits = append(hits, Hit{Node: at.node, Snippet: first(body)})
		}
	}

	return hits, nil
}

func hasTag(tags []string, want string) bool {
	for _, tag := range tags {
		if strings.EqualFold(strings.TrimSpace(tag), want) {
			return true
		}
	}

	return false
}

func (w *Workspace) openMeta(scopeID int64, version int32, blob vault.Blob, ref envelope.EntityRef) (envelope.Meta, error) {
	return envelope.DecryptMeta(
		w.ring.Get(scopeID, version),
		envelope.Sealed{Ciphertext: blob.Ciphertext, Nonce: blob.Nonce},
		ref,
	)
}

func (w *Workspace) openBody(file vault.File) (string, error) {
	body, err := envelope.DecryptContent(
		w.ring.Get(file.KeyScopeID, file.KeyVersion),
		envelope.Sealed{Ciphertext: file.Content.Ciphertext, Nonce: file.Content.Nonce},
		w.fileRef(file),
	)
	if err != nil {
		return "", ErrLocked
	}

	return body, nil
}

func (w *Workspace) fileRef(file vault.File) envelope.EntityRef {
	return envelope.EntityRef{
		VaultID:       w.vaultID,
		Entity:        envelope.EntityFile,
		EntityID:      file.ClientID,
		ScopeClientID: file.KeyScopeClientID,
		KeyVersion:    file.KeyVersion,
	}
}

func (t *tree) note(path string) (*noteAt, error) {
	at, ok := t.notes[clean(path)]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrPath, path)
	}

	if at.node.Locked {
		return nil, ErrLocked
	}

	return at, nil
}

// parentPath is the path of a node's parent, or the empty string at the root.
func parentPath(paths map[int64]string, parent *int64) string {
	if parent == nil {
		return ""
	}

	return paths[*parent]
}

func join(parent, name string) string {
	if parent == "" {
		return name
	}

	return parent + "/" + name
}

// clean normalises a path the way a tool caller is likely to have written it.
func clean(path string) string {
	return strings.Trim(strings.TrimSpace(path), "/")
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}

	sort.Strings(keys)

	return keys
}

const snippetRadius = 90

// excerpt is the text around the first match, so a result says why it matched.
func excerpt(body, needle string) (string, bool) {
	at := strings.Index(strings.ToLower(body), needle)
	if at < 0 {
		return "", false
	}

	start := max(at-snippetRadius, 0)
	end := min(at+len(needle)+snippetRadius, len(body))

	return strings.TrimSpace(body[start:end]), true
}

func first(body string) string {
	if len(body) <= snippetRadius*2 {
		return strings.TrimSpace(body)
	}

	return strings.TrimSpace(body[:snippetRadius*2])
}

func newClientID() string { return uuid.NewString() }
