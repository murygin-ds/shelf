package mcp

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"shelf/internal/envelope"
	"shelf/internal/vault"
)

// tagShape is the frontend's rule, repeated because a tag written here is read there.
var tagShape = regexp.MustCompile(`^[\p{L}\p{N}][\p{L}\p{N}_-]*$`)

// MetaPatch is what SetMeta changes. Nil means "leave it as it is" — the distinction
// matters because metadata is a single ciphertext: writing it back rebuilds every field,
// and a field left out of the rebuild is a field deleted.
type MetaPatch struct {
	Name *string
	Icon *string
	Tags *[]string
}

// SetMeta renames a note or a folder, and sets a note's icon and tags.
//
// One call for all three because they share one ciphertext. Changing a name through a path
// that also names the icon is the only shape that cannot silently drop the icon.
func (w *Workspace) SetMeta(ctx context.Context, path string, patch MetaPatch) (*Node, error) {
	built, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	at := clean(path)

	if note, ok := built.notes[at]; ok {
		return w.setNoteMeta(ctx, built, note, patch)
	}

	if folder, ok := built.folders[at]; ok {
		return w.setFolderMeta(ctx, built, folder, patch)
	}

	return nil, fmt.Errorf("%w: %s", ErrPath, at)
}

func (w *Workspace) setNoteMeta(ctx context.Context, built *tree, at *noteAt, patch MetaPatch) (*Node, error) {
	if at.node.Locked {
		return nil, ErrLocked
	}

	ref := w.fileRef(at.file)

	meta, err := w.openMeta(at.file.KeyScopeID, at.file.KeyVersion, at.file.Meta, ref)
	if err != nil {
		return nil, ErrLocked
	}

	updated, err := apply(meta, patch)
	if err != nil {
		return nil, err
	}

	if updated.Name != meta.Name {
		if err := w.free(built, at.node.Path, updated.Name); err != nil {
			return nil, err
		}
	}

	sealed, err := w.sealMeta(at.file.KeyScopeID, at.file.KeyVersion, updated, ref)
	if err != nil {
		return nil, err
	}

	written, err := w.vaults.UpdateFile(ctx, w.userID, at.file.ID, vault.MetaUpdate{Meta: sealed})
	if err != nil {
		return nil, err
	}

	node := w.noteNode(*written, updated.Name, rename(at.node.Path, updated.Name))
	node.Icon = updated.Icon
	node.Tags = updated.Tags

	return &node, nil
}

func (w *Workspace) setFolderMeta(ctx context.Context, built *tree, at *folderAt, patch MetaPatch) (*Node, error) {
	if at.node.Locked {
		return nil, ErrLocked
	}

	ref := envelope.EntityRef{
		VaultID:       w.vaultID,
		Entity:        envelope.EntityFolder,
		EntityID:      at.folder.ClientID,
		ScopeClientID: at.folder.KeyScopeClientID,
		KeyVersion:    at.folder.KeyVersion,
	}

	meta, err := w.openMeta(at.folder.KeyScopeID, at.folder.KeyVersion, at.folder.Meta, ref)
	if err != nil {
		return nil, ErrLocked
	}

	updated, err := apply(meta, patch)
	if err != nil {
		return nil, err
	}

	if updated.Name != meta.Name {
		if err := w.free(built, at.node.Path, updated.Name); err != nil {
			return nil, err
		}
	}

	sealed, err := w.sealMeta(at.folder.KeyScopeID, at.folder.KeyVersion, updated, ref)
	if err != nil {
		return nil, err
	}

	written, err := w.vaults.UpdateFolder(ctx, w.userID, at.folder.ID, vault.MetaUpdate{Meta: sealed})
	if err != nil {
		return nil, err
	}

	return &Node{
		ID:        written.ID,
		Kind:      KindFolder,
		Path:      rename(at.node.Path, updated.Name),
		Name:      updated.Name,
		Icon:      updated.Icon,
		Tags:      updated.Tags,
		UpdatedAt: written.UpdatedAt,
	}, nil
}

// TrashFolder puts an empty folder in the bin.
//
// Empty only, and deliberately: trashing a folder takes its whole subtree with it, and a
// model that meant to tidy up one stray directory should not be able to remove a project by
// naming its folder. Emptying it first is a sequence somebody can see going wrong.
func (w *Workspace) TrashFolder(ctx context.Context, path string) error {
	built, err := w.read(ctx)
	if err != nil {
		return err
	}

	at, ok := built.folders[clean(path)]
	if !ok {
		return fmt.Errorf("%w: %s", ErrPath, clean(path))
	}

	prefix := at.node.Path + "/"

	var holds []string

	for _, node := range built.nodes {
		if strings.HasPrefix(node.Path, prefix) {
			holds = append(holds, node.Path)
		}
	}

	if len(holds) > 0 {
		return fmt.Errorf("%w: it still holds %d, starting with %s", ErrNotEmpty, len(holds), holds[0])
	}

	return w.vaults.DeleteFolder(ctx, w.userID, at.folder.ID)
}

// Trash lists the bin.
func (w *Workspace) Trash(ctx context.Context) ([]Trashed, error) {
	folders, files, err := w.vaults.Trash(ctx, w.userID, w.vaultID)
	if err != nil {
		return nil, fmt.Errorf("read the trash: %w", err)
	}

	live, err := w.read(ctx)
	if err != nil {
		return nil, err
	}

	// A trashed note may sit in a trashed folder, so the path has to be built from both.
	names := make(map[int64]string, len(folders))
	parents := make(map[int64]*int64, len(folders))

	for _, folder := range folders {
		meta, err := w.openMeta(folder.KeyScopeID, folder.KeyVersion, folder.Meta, envelope.EntityRef{
			VaultID:       w.vaultID,
			Entity:        envelope.EntityFolder,
			EntityID:      folder.ClientID,
			ScopeClientID: folder.KeyScopeClientID,
			KeyVersion:    folder.KeyVersion,
		})

		names[folder.ID] = meta.Name
		parents[folder.ID] = folder.ParentID

		if err != nil {
			names[folder.ID] = Locked
		}
	}

	for path, at := range live.folders {
		names[at.folder.ID] = at.node.Name
		parents[at.folder.ID] = at.folder.ParentID
		_ = path
	}

	var path func(id *int64) string

	path = func(id *int64) string {
		if id == nil {
			return ""
		}

		return join(path(parents[*id]), names[*id])
	}

	out := make([]Trashed, 0, len(folders)+len(files))

	for _, folder := range folders {
		out = append(out, Trashed{
			ID: folder.ID, Kind: KindFolder, Name: names[folder.ID],
			Path: path(&folder.ID), TrashedAt: deletedAt(folder.DeletedAt),
		})
	}

	for _, file := range files {
		meta, err := w.openMeta(file.KeyScopeID, file.KeyVersion, file.Meta, w.fileRef(file))

		name := meta.Name
		if err != nil {
			name = Locked
		}

		out = append(out, Trashed{
			ID: file.ID, Kind: KindNote, Name: name,
			Path: join(path(file.FolderID), name), TrashedAt: deletedAt(file.DeletedAt),
		})
	}

	return out, nil
}

// Restore takes something out of the bin and puts it back where it was.
func (w *Workspace) Restore(ctx context.Context, id int64) (*Trashed, error) {
	binned, err := w.Trash(ctx)
	if err != nil {
		return nil, err
	}

	for _, item := range binned {
		if item.ID != id {
			continue
		}

		// Looked up rather than trusted: this is the check that the id names something in
		// this vault's bin and not a row somewhere else.
		if item.Kind == KindFolder {
			return &item, w.vaults.RestoreFolder(ctx, w.userID, id)
		}

		return &item, w.vaults.RestoreFile(ctx, w.userID, id)
	}

	return nil, fmt.Errorf("%w: nothing in the trash has id %d", ErrPath, id)
}

// free refuses a rename onto a path something else already occupies.
func (w *Workspace) free(built *tree, from, name string) error {
	to := rename(from, name)

	if _, taken := built.notes[to]; taken {
		return fmt.Errorf("%w: %s already exists", ErrPath, to)
	}

	if _, taken := built.folders[to]; taken {
		return fmt.Errorf("%w: %s already exists", ErrPath, to)
	}

	return nil
}

func (w *Workspace) sealMeta(scopeID int64, version int32, meta envelope.Meta, ref envelope.EntityRef) (vault.Blob, error) {
	key := w.ring.Get(scopeID, version)
	if key == nil {
		return vault.Blob{}, ErrLocked
	}

	sealed, err := envelope.EncryptMeta(key, meta, ref)
	if err != nil {
		return vault.Blob{}, fmt.Errorf("seal metadata: %w", err)
	}

	return vault.Blob{Ciphertext: sealed.Ciphertext, Nonce: sealed.Nonce}, nil
}

// apply builds the metadata that will replace what is stored. Everything the patch does not
// mention is carried over, because what is written back is the whole of it.
func apply(current envelope.Meta, patch MetaPatch) (envelope.Meta, error) {
	updated := current

	if patch.Name != nil {
		name := strings.TrimSpace(*patch.Name)

		if name == "" {
			return envelope.Meta{}, fmt.Errorf("%w: a name cannot be empty", ErrPath)
		}

		if len(name) > MaxNameBytes {
			return envelope.Meta{}, fmt.Errorf("%w: a name may be at most %d bytes", ErrPath, MaxNameBytes)
		}

		if strings.Contains(name, "/") {
			return envelope.Meta{}, fmt.Errorf("%w: a name is one segment; use move to change the folder", ErrPath)
		}

		if bad, found := unrenderable(name); found {
			return envelope.Meta{}, fmt.Errorf("%w: a name may not contain %q", ErrPath, bad)
		}

		updated.Name = name
	}

	if patch.Icon != nil {
		updated.Icon = strings.TrimSpace(*patch.Icon)
	}

	if patch.Tags != nil {
		tags, err := normalize(*patch.Tags)
		if err != nil {
			return envelope.Meta{}, err
		}

		updated.Tags = tags
	}

	return updated, nil
}

// normalize puts tags in the form the rest of the system reads: lowercase, no leading hash,
// no duplicates. A tag the browser would refuse is refused here rather than stored and then
// found to be invisible.
func normalize(raw []string) ([]string, error) {
	if len(raw) > MaxTags {
		return nil, fmt.Errorf("%w: at most %d tags", ErrTag, MaxTags)
	}

	seen := make(map[string]struct{}, len(raw))
	tags := make([]string, 0, len(raw))

	for _, tag := range raw {
		text := strings.ToLower(strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(tag), "#")))

		if text == "" {
			continue
		}

		if len(text) > MaxTagBytes {
			return nil, fmt.Errorf("%w: %q is longer than %d bytes", ErrTag, text, MaxTagBytes)
		}

		if !tagShape.MatchString(text) {
			return nil, fmt.Errorf("%w: %q — letters and digits, then letters, digits, - or _", ErrTag, text)
		}

		if _, already := seen[text]; already {
			continue
		}

		seen[text] = struct{}{}
		tags = append(tags, text)
	}

	if len(tags) == 0 {
		return nil, nil
	}

	return tags, nil
}

func deletedAt(at *time.Time) time.Time {
	if at == nil {
		return time.Time{}
	}

	return *at
}

// rename swaps the last segment of a path.
func rename(path, name string) string {
	at := strings.LastIndex(path, "/")
	if at < 0 {
		return name
	}

	return path[:at+1] + name
}
