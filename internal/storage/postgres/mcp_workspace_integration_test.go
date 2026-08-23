//go:build integration

// The connector's reading and writing goes through the same service a person's browser
// does, so what this file proves is that the plaintext round trip survives the whole stack:
// seal in Go, store as ciphertext, read back through the permission query, open again.
package postgres

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"shelf/internal/mcp"
	"shelf/internal/vault"

	"go.uber.org/zap"
)

// workspace wires the connector over the real vault service, as the router does.
func workspace(t *testing.T, f *fixture, repo *MCPRepository) *mcp.Workspace {
	t.Helper()

	ctx := context.Background()
	connector := enable(t, f, repo)

	store := NewVaultRepository(f.pool, nil)
	service := vault.NewService(vault.Deps{
		Vaults: store, Folders: store, Files: store, Tree: store, Sync: store,
		Rekeys: store, Audit: store, Graph: store, Revisions: store, Shares: store,
		CRDT: store, Logger: zap.NewNop(),
	})

	keys, err := repo.Keys(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Keys: %v", err)
	}

	identity, err := mcp.OpenIdentity(connectorSecret, keys)
	if err != nil {
		t.Fatalf("OpenIdentity: %v", err)
	}

	grants, err := repo.Grants(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Grants: %v", err)
	}

	opened, err := mcp.Open(ctx, service, nil, zap.NewNop(), mcp.NewKeyring(identity, grants), identity, connector)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	return opened
}

// A tab that goes away without writing its document back leaves the body behind text that
// still exists: the log holds it, and only a client can fold it in. A write from here would
// invalidate the document and take that log with it, and nobody is in the room to notice —
// so the connector says what it sees when it reads, and refuses to write.
func TestConnectorRefusesToWriteOverEditsNobodyWroteBack(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	space := workspace(t, f, repo)
	ctx := context.Background()

	created, err := space.CreateNote(ctx, "inbox/draft", "half a sentence")
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	store := NewVaultRepository(pool, nil)

	file, err := store.File(ctx, created.ID, f.userID)
	if err != nil {
		t.Fatalf("File: %v", err)
	}

	// Somebody opened the note and typed. Their session ended before the committer wrote
	// the body back, so what they typed is only in the log.
	if _, _, err := store.SeedCRDTDoc(ctx, vault.NewCRDTDoc{
		FileID: file.ID, Epoch: vault.FirstEpoch, Snapshot: snapshot("state"),
		KeyScopeID: file.KeyScopeID, KeyVersion: file.KeyVersion, ContentSeq: file.ContentSeq,
	}, f.userID); err != nil {
		t.Fatalf("seed the document: %v", err)
	}

	if _, err := store.AppendCRDTUpdate(ctx, vault.NewCRDTUpdate{
		FileID: file.ID, Epoch: vault.FirstEpoch, Payload: snapshot("typed"),
		KeyScopeID: file.KeyScopeID, KeyVersion: file.KeyVersion,
	}, f.userID); err != nil {
		t.Fatalf("append an update: %v", err)
	}

	// Reading is fine, and it says the body is not the whole story.
	read, err := space.ReadNote(ctx, "inbox/draft")
	if err != nil {
		t.Fatalf("ReadNote: %v", err)
	}

	if !read.PendingEdits {
		t.Error("the read did not say the body is behind the live copy")
	}

	// The listing and a search report the same thing: what is stored is not the whole note.
	if _, err := space.CreateNote(ctx, "inbox/quiet", "half a sentence, written once"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	listed, err := space.Tree(ctx, "inbox")
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}

	tree := map[string]bool{}
	for _, node := range listed {
		tree[node.Path] = node.PendingEdits
	}

	if !tree["inbox/draft"] {
		t.Error("the listing did not say the edited note has unwritten edits")
	}

	if tree["inbox/quiet"] {
		t.Error("the listing reported unwritten edits on a note nobody has opened")
	}

	hits, err := space.Search(ctx, mcp.Query{Text: "half a sentence"}, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	behind := map[string]bool{}
	for _, hit := range hits {
		behind[hit.Path] = hit.PendingEdits
	}

	if len(hits) != 2 {
		t.Fatalf("the search found %d notes, want both", len(hits))
	}

	if !behind["inbox/draft"] {
		t.Error("the hit for the edited note did not say its body is behind the live copy")
	}

	if behind["inbox/quiet"] {
		t.Error("a note nobody has opened was reported as having unwritten edits")
	}

	if _, err := space.AppendNote(ctx, "inbox/draft", " and more"); !errors.Is(err, mcp.ErrUnsettled) {
		t.Errorf("appending over unwritten edits returned %v, want ErrUnsettled", err)
	}

	if _, err := space.WriteNote(ctx, "inbox/draft", "clobbered", read.ContentSeq); !errors.Is(err, mcp.ErrUnsettled) {
		t.Errorf("writing over unwritten edits returned %v, want ErrUnsettled", err)
	}

	// The refusal took nothing with it: what was typed is still there to be folded in.
	doc, err := store.CRDTDoc(ctx, file.ID)
	if err != nil {
		t.Fatalf("read the document: %v", err)
	}

	if doc.PendingCount != 1 || doc.Epoch != vault.FirstEpoch {
		t.Errorf("the document is at epoch %d with %d updates, want the one it had",
			doc.Epoch, doc.PendingCount)
	}

	// Folding them into the body is the editor's job, and it lifts the refusal: there is
	// nothing left that the body does not carry.
	if _, err := store.UpdateFileContent(ctx, file.ID, vault.ContentUpdate{
		Content:     snapshot("folded body"),
		ExpectedSeq: read.ContentSeq,
		KeyScopeID:  file.KeyScopeID,
		KeyVersion:  file.KeyVersion,
		CRDT: &vault.CRDTCommit{
			Epoch: vault.FirstEpoch, UpToSeq: doc.LastSeq, Snapshot: snapshot("folded"),
		},
	}, f.userID); err != nil {
		t.Fatalf("fold the log into the body: %v", err)
	}

	if _, err := space.WriteNote(ctx, "inbox/draft", "the connector's turn", read.ContentSeq+1); err != nil {
		t.Fatalf("writing after the editor wrote back: %v", err)
	}
}

// busy stands in for the hub reporting that somebody holds a note open.
type busy struct{ editing bool }

func (b busy) Editing(int64) bool { return b.editing }

// A body written from outside a live document raises its epoch and drops the updates that
// have not been folded in yet. That is right when an offline client replays a write, and it
// is somebody's half-typed sentence when it lands during an edit — so it refuses instead.
func TestConnectorRefusesToWriteOverALiveSession(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	quiet := workspace(t, f, repo)

	if _, err := quiet.CreateNote(ctx, "inbox/draft", "half a sentence"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	// The same vault, opened again with the hub saying the note is open.
	connector, err := repo.Connector(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Connector: %v", err)
	}

	keys, err := repo.Keys(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Keys: %v", err)
	}

	identity, err := mcp.OpenIdentity(connectorSecret, keys)
	if err != nil {
		t.Fatalf("OpenIdentity: %v", err)
	}

	grants, err := repo.Grants(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Grants: %v", err)
	}

	store := NewVaultRepository(pool, nil)
	vaults := vault.NewService(vault.Deps{
		Vaults: store, Folders: store, Files: store, Tree: store, Sync: store,
		Rekeys: store, Audit: store, Graph: store, Revisions: store, Shares: store,
		CRDT: store, Logger: zap.NewNop(),
	})

	occupied, err := mcp.Open(ctx, vaults, busy{editing: true}, zap.NewNop(),
		mcp.NewKeyring(identity, grants), identity, connector)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	note, err := occupied.ReadNote(ctx, "inbox/draft")
	if err != nil {
		t.Fatalf("ReadNote: %v", err)
	}

	// Reading is fine; it takes nothing away from anybody.
	if note.Body != "half a sentence" {
		t.Errorf("the body read back as %q", note.Body)
	}

	if _, err := occupied.WriteNote(ctx, "inbox/draft", "clobbered", note.ContentSeq); !errors.Is(err, mcp.ErrBusy) {
		t.Fatalf("writing over a live session returned %v, want ErrBusy", err)
	}

	if _, err := occupied.AppendNote(ctx, "inbox/draft", " and more"); !errors.Is(err, mcp.ErrBusy) {
		t.Errorf("appending over a live session returned %v, want ErrBusy", err)
	}

	// Nothing was written, so the text somebody has open is exactly as they left it.
	after, err := quiet.ReadNote(ctx, "inbox/draft")
	if err != nil {
		t.Fatalf("ReadNote after: %v", err)
	}

	if after.Body != "half a sentence" || after.ContentSeq != note.ContentSeq {
		t.Errorf("the refused write still moved the note: %q at %d", after.Body, after.ContentSeq)
	}
}

func TestConnectorWritesAndReadsNotes(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	const path = "projects/alpha/decisions"

	body := "# Decisions\n\nPicked Postgres. Ёжик, 日本語, R&D <draft>.\n"

	created, err := space.CreateNote(ctx, path, body)
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if created.Path != path {
		t.Errorf("created at %q, want %q", created.Path, path)
	}

	// The folders on the way were created too, and the tree names them.
	nodes, err := space.Tree(ctx, "")
	if err != nil {
		t.Fatalf("Tree: %v", err)
	}

	seen := map[string]string{}
	for _, node := range nodes {
		seen[node.Path] = node.Kind
	}

	for path, kind := range map[string]string{
		"projects":                 mcp.KindFolder,
		"projects/alpha":           mcp.KindFolder,
		"projects/alpha/decisions": mcp.KindNote,
	} {
		if seen[path] != kind {
			t.Errorf("tree has %q as %q, want %q", path, seen[path], kind)
		}
	}

	read, err := space.ReadNote(ctx, path)
	if err != nil {
		t.Fatalf("ReadNote: %v", err)
	}

	if read.Body != body {
		t.Errorf("body came back as %q", read.Body)
	}

	// A stale sequence is refused rather than merged: nobody here can merge two ciphertexts.
	if _, err := space.WriteNote(ctx, path, "clobbered", read.ContentSeq-1); !errors.Is(err, vault.ErrVersionConflict) {
		t.Errorf("writing at a stale sequence returned %v, want a conflict", err)
	}

	updated, err := space.WriteNote(ctx, path, "# Decisions\n\nRewritten.\n", read.ContentSeq)
	if err != nil {
		t.Fatalf("WriteNote: %v", err)
	}

	if updated.ContentSeq <= read.ContentSeq {
		t.Errorf("the sequence did not advance: %d then %d", read.ContentSeq, updated.ContentSeq)
	}

	appended, err := space.AppendNote(ctx, path, "- and one more thing\n")
	if err != nil {
		t.Fatalf("AppendNote: %v", err)
	}

	if !strings.HasSuffix(appended.Body, "- and one more thing\n") {
		t.Errorf("append produced %q", appended.Body)
	}

	if !strings.Contains(appended.Body, "Rewritten.") {
		t.Error("append lost what was already there")
	}
}

// What the connector writes has to reach the graph, or a vault a model fills stays a pile of
// unconnected notes until somebody opens each one in a browser and saves it again.
func TestConnectorRecordsTheLinksItWrites(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	// Two projects with the same note name, which is what the template produces: a bare
	// [[CLAUDE.md]] cannot say which of them is meant, and a path can.
	alpha, err := space.CreateNote(ctx, "projects/alpha/CLAUDE.md", "# Alpha\n")
	if err != nil {
		t.Fatalf("CreateNote alpha: %v", err)
	}

	beta, err := space.CreateNote(ctx, "projects/beta/CLAUDE.md", "# Beta\n")
	if err != nil {
		t.Fatalf("CreateNote beta: %v", err)
	}

	log, err := space.CreateNote(ctx, "memory/2026-08.md",
		"Shipped [[projects/beta/CLAUDE.md]], parked [[projects/alpha/CLAUDE.md|alpha]].\n")
	if err != nil {
		t.Fatalf("CreateNote log: %v", err)
	}

	// Read as the owner, which is the browser's view of the same graph.
	store := NewVaultRepository(pool, nil)

	drawn := edgesOf(t, store, f, log.ID)
	if want := []int64{beta.ID, alpha.ID}; !sameSet(drawn, want) {
		t.Errorf("the graph holds %v, want edges to %v", drawn, want)
	}

	// An append resolves against the body it produces, so the earlier edges survive it and
	// the new one joins them.
	if _, err := space.AppendNote(ctx, "memory/2026-08.md", "Also read [[Beta]].\n"); err != nil {
		t.Fatalf("AppendNote: %v", err)
	}

	if drawn := edgesOf(t, store, f, log.ID); !sameSet(drawn, []int64{beta.ID, alpha.ID}) {
		t.Errorf("appending left the graph at %v", drawn)
	}

	// A title nothing carries is dropped rather than stored, and a body that says nothing
	// takes its edges with it: the note is the truth about what it points at.
	read, err := space.ReadNote(ctx, "memory/2026-08.md")
	if err != nil {
		t.Fatalf("ReadNote: %v", err)
	}

	if _, err := space.WriteNote(ctx, "memory/2026-08.md", "Nothing points anywhere now.\n",
		read.ContentSeq); err != nil {
		t.Fatalf("WriteNote: %v", err)
	}

	if drawn := edgesOf(t, store, f, log.ID); len(drawn) != 0 {
		t.Errorf("the rewrite left %v behind", drawn)
	}
}

// edgesOf lists what one note points at, as the vault's owner sees the graph.
func edgesOf(t *testing.T, store *VaultRepository, f *fixture, from int64) []int64 {
	t.Helper()

	graph, err := store.Graph(context.Background(), f.vaultID, f.ownerID)
	if err != nil {
		t.Fatalf("Graph: %v", err)
	}

	out := []int64{}

	for _, edge := range graph.Edges {
		if edge.From != strconv.FormatInt(from, 10) {
			continue
		}

		to, err := strconv.ParseInt(edge.To, 10, 64)
		if err != nil {
			t.Fatalf("a visible node is named %q rather than by its id", edge.To)
		}

		out = append(out, to)
	}

	return out
}

func sameSet(got, want []int64) bool {
	if len(got) != len(want) {
		return false
	}

	found := make(map[int64]bool, len(got))
	for _, id := range got {
		found[id] = true
	}

	for _, id := range want {
		if !found[id] {
			return false
		}
	}

	return true
}

func TestConnectorSearchesBodies(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	for path, body := range map[string]string{
		"context/stack":    "We run Postgres 17 and Go on the server.",
		"context/people":   "Rita owns onboarding.",
		"inbox/scratchpad": "nothing to see",
	} {
		if _, err := space.CreateNote(ctx, path, body); err != nil {
			t.Fatalf("CreateNote %s: %v", path, err)
		}
	}

	hits, err := space.Search(ctx, mcp.Query{Text: "postgres"}, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	if len(hits) != 1 || hits[0].Path != "context/stack" {
		t.Fatalf("search returned %d hits: %+v", len(hits), hits)
	}

	if !strings.Contains(strings.ToLower(hits[0].Snippet), "postgres") {
		t.Errorf("the snippet does not show the match: %q", hits[0].Snippet)
	}

	// A title match counts even when the body says nothing.
	byTitle, err := space.Search(ctx, mcp.Query{Text: "scratchpad"}, 10)
	if err != nil {
		t.Fatalf("Search by title: %v", err)
	}

	if len(byTitle) != 1 {
		t.Errorf("searching a title returned %d hits", len(byTitle))
	}
}

func TestConnectorRefusesWhatItShould(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	if _, err := space.ReadNote(ctx, "nothing/here"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("reading a missing path returned %v", err)
	}

	if _, err := space.CreateFolder(ctx, "../escape"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a traversal segment was accepted: %v", err)
	}

	if _, err := space.CreateNote(ctx, "big", strings.Repeat("x", mcp.MaxBodyBytes+1)); !errors.Is(err, mcp.ErrTooLarge) {
		t.Errorf("an oversized body returned %v", err)
	}

	if _, err := space.CreateNote(ctx, "notes/one", "first"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if _, err := space.CreateNote(ctx, "notes/one", "second"); !errors.Is(err, mcp.ErrPath) {
		t.Error("a second note took a path that was already taken")
	}
}

// The optimistic lock has no value that means "whatever it is now". A caller that does not
// hold a sequence has not read the note, and the guard against overwriting somebody must not
// be something a caller can opt out of by sending zero.
func TestConnectorWriteHasNoBlindOverwrite(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	const path = "notes/locked"

	if _, err := space.CreateNote(ctx, path, "what somebody wrote"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	read, err := space.ReadNote(ctx, path)
	if err != nil {
		t.Fatalf("ReadNote: %v", err)
	}

	for _, seq := range []int64{0, -1, read.ContentSeq - 1, read.ContentSeq + 1} {
		if _, err := space.WriteNote(ctx, path, "clobbered", seq); !errors.Is(err, vault.ErrVersionConflict) {
			t.Errorf("writing at sequence %d returned %v, want a conflict", seq, err)
		}
	}

	after, err := space.ReadNote(ctx, path)
	if err != nil {
		t.Fatalf("ReadNote after: %v", err)
	}

	if after.Body != "what somebody wrote" {
		t.Fatalf("a refused write still changed the note to %q", after.Body)
	}

	if _, err := space.WriteNote(ctx, path, "written properly", read.ContentSeq); err != nil {
		t.Fatalf("the correct sequence was refused: %v", err)
	}
}

// Names are sealed metadata, so the request-body cap the browser meets never runs here.
func TestConnectorBoundsNamesAndDepth(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	long := strings.Repeat("n", mcp.MaxNameBytes+1)

	if _, err := space.CreateNote(ctx, long, "x"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a %d-byte name was accepted: %v", len(long), err)
	}

	if _, err := space.CreateFolder(ctx, long); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a %d-byte folder name was accepted: %v", len(long), err)
	}

	// Creating walks the path a level at a time, so a depth the tree will refuse has to be
	// caught before the levels above it are written.
	deep := strings.TrimSuffix(strings.Repeat("d/", mcp.MaxDepth+5), "/")

	if _, err := space.CreateFolder(ctx, deep); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a %d-level path was accepted: %v", mcp.MaxDepth+5, err)
	}

	var folders int

	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM folders WHERE vault_id = $1`, f.vaultID).Scan(&folders); err != nil {
		t.Fatalf("count folders: %v", err)
	}

	if folders != 0 {
		t.Errorf("a refused path left %d folders behind", folders)
	}
}

// A connector writes names a person then reads in a list. A right-to-left override makes
// "gnp.exe" look like a picture, and a zero-width space makes two names look identical.
func TestConnectorRefusesNamesThatLie(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	for name, path := range map[string]string{
		"a right-to-left override": "report\u202egnp.exe.md",
		"a zero-width space":       "inv\u200boice.md",
		"a carriage return":        "one\rtwo.md",
		"a null byte":              "one\x00two.md",
		"an escape sequence":       "one\x1b[31mtwo.md",
	} {
		if _, err := space.CreateNote(ctx, path, "x"); !errors.Is(err, mcp.ErrPath) {
			t.Errorf("%s was accepted in a name: %v", name, err)
		}
	}

	// A tab is only whitespace, and a name with one in it is merely untidy.
	if _, err := space.CreateNote(ctx, "one\ttwo.md", "x"); err != nil {
		t.Errorf("a tab was refused: %v", err)
	}
}

// A path is the only address these tools have, so one path cannot mean two things.
func TestConnectorKeepsOnePathNamespace(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	if _, err := space.CreateFolder(ctx, "shared"); err != nil {
		t.Fatalf("CreateFolder: %v", err)
	}

	if _, err := space.CreateNote(ctx, "shared", "x"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a note took the path of a folder: %v", err)
	}

	if _, err := space.CreateNote(ctx, "taken.md", "x"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if _, err := space.CreateFolder(ctx, "taken.md"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a folder took the path of a note: %v", err)
	}

	// Moving must not create the shadow folder either.
	if _, err := space.CreateNote(ctx, "movable.md", "x"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if _, err := space.MoveNote(ctx, "movable.md", "taken.md"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a move created a folder where a note already was: %v", err)
	}
}

// Renaming rewrites the one field that also holds the icon and the tags, so anything the
// caller did not mention has to survive it.
func TestConnectorRenameKeepsEverythingElse(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	if _, err := space.CreateNote(ctx, "projects/alpha/decisions.md", "chose one"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	icon, tags := "book", []string{"Alpha", "#WIP", "alpha"}

	if _, err := space.SetMeta(ctx, "projects/alpha/decisions.md", mcp.MetaPatch{
		Icon: &icon, Tags: &tags,
	}); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}

	name := "adr.md"

	renamed, err := space.SetMeta(ctx, "projects/alpha/decisions.md", mcp.MetaPatch{Name: &name})
	if err != nil {
		t.Fatalf("rename: %v", err)
	}

	if renamed.Path != "projects/alpha/adr.md" {
		t.Errorf("renamed to %q", renamed.Path)
	}

	// Lowercased, hash stripped, duplicate dropped — the form the rest of the system reads.
	if got := strings.Join(renamed.Tags, ","); got != "alpha,wip" {
		t.Errorf("tags came back as %q", got)
	}

	if renamed.Icon != "book" {
		t.Errorf("the rename dropped the icon: %q", renamed.Icon)
	}

	note, err := space.ReadNote(ctx, "projects/alpha/adr.md")
	if err != nil {
		t.Fatalf("ReadNote after rename: %v", err)
	}

	if note.Body != "chose one" {
		t.Errorf("the rename touched the body: %q", note.Body)
	}

	// A folder renames through the same call.
	folder := "beta"

	if _, err := space.SetMeta(ctx, "projects/alpha", mcp.MetaPatch{Name: &folder}); err != nil {
		t.Fatalf("rename folder: %v", err)
	}

	if _, err := space.ReadNote(ctx, "projects/beta/adr.md"); err != nil {
		t.Errorf("the note did not move with its folder: %v", err)
	}
}

func TestConnectorRenameRefusesWhatItShould(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	for _, path := range []string{"notes/one.md", "notes/two.md"} {
		if _, err := space.CreateNote(ctx, path, "x"); err != nil {
			t.Fatalf("CreateNote %s: %v", path, err)
		}
	}

	taken := "two.md"

	if _, err := space.SetMeta(ctx, "notes/one.md", mcp.MetaPatch{Name: &taken}); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a rename onto an occupied path was allowed: %v", err)
	}

	for name, bad := range map[string]string{
		"a path rather than a name": "other/one.md",
		"an empty name":             "   ",
		"a bidi override":           "one\u202egnp.exe",
	} {
		value := bad

		if _, err := space.SetMeta(ctx, "notes/one.md", mcp.MetaPatch{Name: &value}); !errors.Is(err, mcp.ErrPath) {
			t.Errorf("%s was accepted as a name: %v", name, err)
		}
	}

	for name, bad := range map[string][]string{
		"a tag with a space":    {"two words"},
		"a tag starting with -": {"-lead"},
	} {
		value := bad

		if _, err := space.SetMeta(ctx, "notes/one.md", mcp.MetaPatch{Tags: &value}); !errors.Is(err, mcp.ErrTag) {
			t.Errorf("%s was accepted: %v", name, err)
		}
	}
}

// The gap this closes: trashing the only note in a folder used to leave the folder behind
// with nothing able to remove it.
func TestConnectorTrashesAndRestores(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	if _, err := space.CreateNote(ctx, "inbox/subfolder-test/stray.md", "x"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	// A folder with something in it stays, and says what is in the way.
	if err := space.TrashFolder(ctx, "inbox/subfolder-test"); !errors.Is(err, mcp.ErrNotEmpty) {
		t.Fatalf("trashing a full folder returned %v, want ErrNotEmpty", err)
	}

	if err := space.TrashNote(ctx, "inbox/subfolder-test/stray.md"); err != nil {
		t.Fatalf("TrashNote: %v", err)
	}

	if err := space.TrashFolder(ctx, "inbox/subfolder-test"); err != nil {
		t.Fatalf("TrashFolder once empty: %v", err)
	}

	binned, err := space.Trash(ctx)
	if err != nil {
		t.Fatalf("Trash: %v", err)
	}

	kinds := map[string]int64{}
	for _, item := range binned {
		kinds[item.Kind+":"+item.Name] = item.ID
	}

	note, ok := kinds[mcp.KindNote+":stray.md"]
	if !ok {
		t.Fatalf("the trashed note is not in the bin: %+v", binned)
	}

	if _, ok := kinds[mcp.KindFolder+":subfolder-test"]; !ok {
		t.Fatalf("the trashed folder is not in the bin: %+v", binned)
	}

	// Restoring a folder brings back everything that was under it, in one statement — so
	// the note comes back with it, and its own id is no longer in the bin. A caller that
	// restored the folder and then reached for the note has nothing left to do.
	if _, err := space.Restore(ctx, kinds[mcp.KindFolder+":subfolder-test"]); err != nil {
		t.Fatalf("restore folder: %v", err)
	}

	if _, err := space.ReadNote(ctx, "inbox/subfolder-test/stray.md"); err != nil {
		t.Errorf("the note did not come back with its folder: %v", err)
	}

	if _, err := space.Restore(ctx, note); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("the note was still in the bin after its folder came back: %v", err)
	}

	// A note trashed on its own comes back on its own.
	if err := space.TrashNote(ctx, "inbox/subfolder-test/stray.md"); err != nil {
		t.Fatalf("TrashNote again: %v", err)
	}

	again, err := space.Trash(ctx)
	if err != nil {
		t.Fatalf("Trash: %v", err)
	}

	var id int64
	for _, item := range again {
		if item.Name == "stray.md" {
			id = item.ID
		}
	}

	if _, err := space.Restore(ctx, id); err != nil {
		t.Fatalf("restore note on its own: %v", err)
	}

	if _, err := space.ReadNote(ctx, "inbox/subfolder-test/stray.md"); err != nil {
		t.Errorf("the restored note is not back: %v", err)
	}

	// An id that is not in this bin is not a handle.
	if _, err := space.Restore(ctx, 999999); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("restoring an unknown id returned %v", err)
	}
}

func TestConnectorSearchNarrows(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	for path, body := range map[string]string{
		"projects/alpha/notes.md": "Postgres is the store here.",
		"context/stack.md":        "Postgres and Go.",
	} {
		if _, err := space.CreateNote(ctx, path, body); err != nil {
			t.Fatalf("CreateNote %s: %v", path, err)
		}
	}

	tags := []string{"infra"}
	if _, err := space.SetMeta(ctx, "context/stack.md", mcp.MetaPatch{Tags: &tags}); err != nil {
		t.Fatalf("SetMeta: %v", err)
	}

	all, err := space.Search(ctx, mcp.Query{Text: "postgres"}, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}

	if len(all) != 2 {
		t.Fatalf("an unscoped search found %d, want 2", len(all))
	}

	under, err := space.Search(ctx, mcp.Query{Text: "postgres", Under: "projects"}, 10)
	if err != nil {
		t.Fatalf("scoped search: %v", err)
	}

	if len(under) != 1 || under[0].Path != "projects/alpha/notes.md" {
		t.Errorf("scoping to projects/ found %+v", under)
	}

	// A tag is enough on its own, with or without the hash.
	tagged, err := space.Search(ctx, mcp.Query{Tag: "#infra"}, 10)
	if err != nil {
		t.Fatalf("tag search: %v", err)
	}

	if len(tagged) != 1 || tagged[0].Path != "context/stack.md" {
		t.Errorf("searching by tag found %+v", tagged)
	}

	if _, err := space.Search(ctx, mcp.Query{}, 10); !errors.Is(err, mcp.ErrPath) {
		t.Error("a search with nothing to look for was accepted")
	}

	if _, err := space.Search(ctx, mcp.Query{Text: "x", Under: "nowhere"}, 10); !errors.Is(err, mcp.ErrPath) {
		t.Error("a search under a folder that does not exist was accepted")
	}
}

// Trashing hides a note from the tree without destroying anything.
func TestConnectorTrashesRatherThanDestroys(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	space := workspace(t, f, NewMCPRepository(pool, nil))
	ctx := context.Background()

	if _, err := space.CreateNote(ctx, "inbox/temporary", "draft"); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if err := space.TrashNote(ctx, "inbox/temporary"); err != nil {
		t.Fatalf("TrashNote: %v", err)
	}

	if _, err := space.ReadNote(ctx, "inbox/temporary"); !errors.Is(err, mcp.ErrPath) {
		t.Errorf("a trashed note is still in the tree: %v", err)
	}

	var rows int

	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM files WHERE vault_id = $1 AND deleted_at IS NOT NULL`, f.vaultID).Scan(&rows)
	if err != nil {
		t.Fatalf("count trashed: %v", err)
	}

	if rows != 1 {
		t.Errorf("%d rows in the trash, want 1 — trashing must not delete", rows)
	}
}
