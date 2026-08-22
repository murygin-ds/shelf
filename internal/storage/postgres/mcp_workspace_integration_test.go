//go:build integration

// The connector's reading and writing goes through the same service a person's browser
// does, so what this file proves is that the plaintext round trip survives the whole stack:
// seal in Go, store as ciphertext, read back through the permission query, open again.
package postgres

import (
	"context"
	"errors"
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

	opened, err := mcp.Open(ctx, service, nil, mcp.NewKeyring(identity, grants), identity, connector)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	return opened
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

	occupied, err := mcp.Open(ctx, vaults, busy{editing: true},
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

	hits, err := space.Search(ctx, "postgres", 10)
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
	byTitle, err := space.Search(ctx, "scratchpad", 10)
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
