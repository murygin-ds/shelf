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
)

// MaxBodyBytes is the largest note body that still fits the ciphertext ceiling once it has
// been framed, padded to a block and given its authentication tag. Kept identical to the
// bound the browser uses, so a note Claude writes is one a person could have written.
const MaxBodyBytes = 4*1024*1024 - envelope.PadBlock - 16

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
	// ErrTooLarge refuses a body that would not fit.
	ErrTooLarge = errors.New("the body is too large")
	// ErrPath reports a path that names nothing, or names the wrong kind of thing.
	ErrPath = errors.New("no such path")
	// ErrLocked reports a node this connector holds no key for.
	ErrLocked = errors.New("this connector holds no key for that")
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
	CreateFile(ctx context.Context, userID int64, in vault.NewFile) (*vault.File, error)
	UpdateFile(ctx context.Context, userID, fileID int64, in vault.MetaUpdate) (*vault.File, error)
	UpdateContent(ctx context.Context, userID, fileID int64, in vault.ContentUpdate) (*vault.File, error)
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
func Open(
	ctx context.Context,
	vaults Vaults,
	live Live,
	ring *Keyring,
	identity *envelope.Identity,
	connector *Connector,
) (*Workspace, error) {
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

	node := at.node
	node.ContentSeq = file.ContentSeq

	return &Note{Node: node, Body: body}, nil
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

// Search looks through the bodies and the names. It decrypts the whole vault to do it,
// which is the only way: the index the browser keeps lives in a tab this server has no
// access to, and there is nothing on disk to search that is not ciphertext.
func (w *Workspace) Search(ctx context.Context, query string, limit int) ([]Hit, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return nil, fmt.Errorf("%w: an empty query", ErrPath)
	}

	paths := sortedKeys(built.notes)

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
