package mcp

import (
	"fmt"
	"strings"
	"testing"

	"shelf/internal/vault"
)

// The tree a connector writes into, as the template lays it out: one CLAUDE.md per project
// and one at the root, which is exactly the case a title cannot settle.
var vaultNotes = []linkable{
	{id: 1, name: "CLAUDE.md", path: "CLAUDE.md"},
	{id: 2, name: "profile.md", path: "context/profile.md"},
	{id: 3, name: "CLAUDE.md", path: "projects/shelf/CLAUDE.md"},
	{id: 4, name: "decisions.md", path: "projects/shelf/decisions.md"},
	{id: 5, name: "CLAUDE.md", path: "projects/atlas/CLAUDE.md"},
}

func TestResolveLinksMatchesTitlesTheWayTheBrowserDoes(t *testing.T) {
	got := resolveLinks("see [[  Profile.MD ]] and [[decisions.md|the log]]", vaultNotes, 0)

	if want := []int64{2, 4}; !equal(got, want) {
		t.Errorf("resolved %v, want %v", got, want)
	}
}

// The reason paths are matched at all: three notes here are called CLAUDE.md, and a title
// picks one of them by age rather than by what the writer meant.
func TestResolveLinksTellsRepeatedTitlesApartByPath(t *testing.T) {
	got := resolveLinks("[[projects/atlas/CLAUDE.md]] then [[/projects/shelf/CLAUDE.md/]]", vaultNotes, 0)

	if want := []int64{5, 3}; !equal(got, want) {
		t.Errorf("resolved %v, want %v", got, want)
	}
}

func TestResolveLinksSettlesASharedTitleOnTheOlderNote(t *testing.T) {
	got := resolveLinks("[[CLAUDE.md]]", vaultNotes, 0)

	if want := []int64{1}; !equal(got, want) {
		t.Errorf("resolved %v, want %v — the lower id is what the browser picks", got, want)
	}
}

func TestResolveLinksDropsWhatItCannotResolve(t *testing.T) {
	// An unmatched title is a title, and the server holds none to match it against. It is
	// dropped rather than carried anywhere.
	got := resolveLinks("[[Nowhere]] [[projects/gone/CLAUDE.md]] [[decisions.md]]", vaultNotes, 0)

	if want := []int64{4}; !equal(got, want) {
		t.Errorf("resolved %v, want %v", got, want)
	}
}

func TestResolveLinksDropsSelfAndRepeats(t *testing.T) {
	body := "[[decisions.md]] [[projects/shelf/decisions.md]] [[profile.md]] [[Profile.md]]"

	got := resolveLinks(body, vaultNotes, 4)

	if want := []int64{2}; !equal(got, want) {
		t.Errorf("resolved %v, want %v", got, want)
	}
}

// A body over the ceiling is a generated index. Stopping at the bound keeps the note
// writable, where sending everything would have the domain refuse the batch whole.
func TestResolveLinksStopsAtTheBatchCeiling(t *testing.T) {
	notes := make([]linkable, 0, vault.MaxLinksPerNote+10)
	body := strings.Builder{}

	for i := range vault.MaxLinksPerNote + 10 {
		name := fmt.Sprintf("note-%d", i)
		notes = append(notes, linkable{id: int64(i + 1), name: name, path: name})
		body.WriteString("[[" + name + "]] ")
	}

	if got := resolveLinks(body.String(), notes, 0); len(got) != vault.MaxLinksPerNote {
		t.Errorf("resolved %d links, want the ceiling of %d", len(got), vault.MaxLinksPerNote)
	}
}

func TestResolveLinksIgnoresBracketsThatAreNotLinks(t *testing.T) {
	if got := resolveLinks("[[]] [[ ]] [profile.md] [[unclosed", vaultNotes, 0); len(got) != 0 {
		t.Errorf("resolved %v from brackets that are not links", got)
	}

	// A stray bracket must not swallow the rest of the note into one "title".
	if got := resolveLinks("[[profile.md\nCLAUDE.md]]", vaultNotes, 0); len(got) != 0 {
		t.Errorf("resolved %v across a line break", got)
	}
}

func equal(got, want []int64) bool {
	if len(got) != len(want) {
		return false
	}

	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}

	return true
}
