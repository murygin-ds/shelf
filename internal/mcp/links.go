package mcp

import (
	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"

	"shelf/internal/vault"
)

// wikilink is `[[target]]` or `[[target|shown text]]`, never crossing a line.
//
// The same expression the browser applies (`web/src/lib/wikilinks.ts`). The graph is one
// artifact both write into, so a body that draws an edge when a person saves it has to draw
// the same edge when the connector writes it.
var wikilink = regexp.MustCompile(`\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]`)

// linkable is one note a link may point at.
type linkable struct {
	id   int64
	name string
	path string
}

// linkables lists the notes a link written in this vault can resolve to.
//
// Locked notes are left out: their names are a placeholder rather than a title, so nothing
// a writer typed could have meant one of them.
func (t *tree) linkables() []linkable {
	out := make([]linkable, 0, len(t.notes))

	for path, at := range t.notes {
		if at.node.Locked {
			continue
		}

		out = append(out, linkable{id: at.file.ID, name: at.node.Name, path: path})
	}

	return out
}

// resolveLinks turns the `[[links]]` in a body into the note ids they point at.
//
// Paths are matched before titles because this tree repeats titles by design: every project
// carries its own CLAUDE.md, and a bare `[[CLAUDE.md]]` cannot say which. Titles still
// resolve, since that is what a person types in the editor, and a title two notes share
// settles on the lower id — the same tie-break the browser makes, so the same body draws the
// same edge wherever it is saved.
//
// A target that matches nothing is dropped rather than reported: it is a title somebody
// wrote, and the server holds no titles to match it against.
func resolveLinks(body string, notes []linkable, self int64) []int64 {
	byPath := make(map[string]int64, len(notes))
	byTitle := make(map[string]int64, len(notes))

	for _, note := range notes {
		byPath[fold(note.path)] = note.id

		title := fold(note.name)
		if existing, taken := byTitle[title]; !taken || note.id < existing {
			byTitle[title] = note.id
		}
	}

	resolved := make([]int64, 0, len(notes))
	seen := make(map[int64]bool, len(notes))

	for _, match := range wikilink.FindAllStringSubmatch(body, -1) {
		target := fold(match[1])
		if target == "" {
			continue
		}

		id, found := byPath[target]
		if !found {
			id, found = byTitle[target]
		}

		// A note linking to itself draws a loop and says nothing.
		if !found || id == self || seen[id] {
			continue
		}

		seen[id] = true
		resolved = append(resolved, id)

		// A body past the ceiling is a generated index, and the write is refused whole
		// rather than partly if it goes over. Stopping keeps the note writable.
		if len(resolved) == vault.MaxLinksPerNote {
			break
		}
	}

	return resolved
}

// fold normalises a target the way both indexes are keyed: a path a caller wrote with
// stray slashes and a title written in another case name the same note.
//
// NFC first, in the same order `fold` in web/src/lib/wikilinks.ts applies it. "й" has a
// composed and a decomposed spelling, and a title pasted from a macOS source carries the
// decomposed one while the link typed at it carries the composed one — two byte strings for
// one word. Folding on one side only would make the edge depend on who saved the note last.
func fold(s string) string {
	return strings.ToLower(clean(norm.NFC.String(s)))
}
