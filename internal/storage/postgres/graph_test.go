package postgres

import (
	"strconv"
	"strings"
	"testing"

	"shelf/internal/vault"
)

// assembleGraph decides what a reader is allowed to see of the vault's shape. It is
// deliberately in Go rather than SQL so both halves of the answer — the nodes and the edges
// — come from one place and cannot disagree. These are the rules it has to keep.

func visible(id int64) vault.GraphNode {
	return vault.GraphNode{Ref: refOf(id), FileID: id, ClientID: "note-" + refOf(id)}
}

func masked() vault.GraphNode { return vault.GraphNode{Locked: true} }

// refOf is what graphNodes does for a visible node: the file id, as a string.
func refOf(id int64) string { return strconv.FormatInt(id, 10) }

// index maps file ids onto positions the way graphNodes does.
func index(ids ...int64) map[int64]int {
	out := make(map[int64]int, len(ids))

	for i, id := range ids {
		out[id] = i
	}

	return out
}

func refs(graph *vault.Graph) string {
	parts := make([]string, 0, len(graph.Nodes))

	for _, node := range graph.Nodes {
		parts = append(parts, node.Ref)
	}

	return strings.Join(parts, ",")
}

// TestMaskedNodesComeLast pins the ordering. Rows arrive sorted by file id, so a masked
// node left in place would sit between two ids the caller knows — which identifies it just
// as surely as handing over the id would.
func TestMaskedNodesComeLast(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), masked(), visible(3)}
	links := []vault.Link{{From: 1, To: 2}, {From: 2, To: 3}}

	graph := assembleGraph(nodes, index(1, 2, 3), links, true)

	if got := refs(graph); got != "1,3,locked-1" {
		t.Fatalf("node order = %q, want the masked one last", got)
	}

	if graph.Locked != 1 {
		t.Fatalf("Locked = %d, want 1", graph.Locked)
	}
}

// TestAMaskedNodeNobodyPointsAtIsDropped pins the rule that keeps the count of unreadable
// notes out of the answer: a masked node earns its place only by being connected to
// something the caller can see.
func TestAMaskedNodeNobodyPointsAtIsDropped(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), masked(), masked()}
	links := []vault.Link{{From: 1, To: 2}}

	graph := assembleGraph(nodes, index(1, 2, 3), links, true)

	if got := refs(graph); got != "1,locked-1" {
		t.Fatalf("nodes = %q, want the unconnected masked node gone", got)
	}
}

// TestPrivateClustersAreNotDrawn pins the rule that stops a graph of notes the caller has
// nothing to do with appearing on their screen. Without it, a locked-to-locked edge gives
// both ends a degree and drags the whole cluster into the answer.
func TestPrivateClustersAreNotDrawn(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), masked(), masked()}
	links := []vault.Link{{From: 2, To: 3}}

	graph := assembleGraph(nodes, index(1, 2, 3), links, true)

	if got := refs(graph); got != "1" {
		t.Fatalf("nodes = %q, want only the visible one", got)
	}

	if len(graph.Edges) != 0 {
		t.Fatalf("edges = %v, want none", graph.Edges)
	}
}

// TestTurningMaskingOffDropsTheEdgesToo pins the other setting: a vault that will not draw
// what a reader cannot open must not leave the edges pointing at nothing either.
func TestTurningMaskingOffDropsTheEdgesToo(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), masked(), visible(3)}
	links := []vault.Link{{From: 1, To: 2}, {From: 1, To: 3}}

	graph := assembleGraph(nodes, index(1, 2, 3), links, false)

	if got := refs(graph); got != "1,3" {
		t.Fatalf("nodes = %q, want no masked node", got)
	}

	if len(graph.Edges) != 1 || graph.Edges[0].From != "1" || graph.Edges[0].To != "3" {
		t.Fatalf("edges = %v, want only the visible pair", graph.Edges)
	}

	if graph.RevealsLocked {
		t.Fatal("RevealsLocked = true, want the setting reported back")
	}

	// And the other direction, or hardcoding the field to false would pass.
	if !assembleGraph(nodes, index(1, 2, 3), links, true).RevealsLocked {
		t.Fatal("RevealsLocked = false when masking is on, want the setting reported back")
	}
}

// TestDegreeCountsOnlyKeptEdges pins what the view sizes its dots by. Counting dropped
// edges would make a note look busier than the picture shows.
func TestDegreeCountsOnlyKeptEdges(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), visible(2), masked()}
	links := []vault.Link{{From: 1, To: 2}, {From: 1, To: 3}, {From: 2, To: 3}}

	graph := assembleGraph(nodes, index(1, 2, 3), links, false)

	if got := refs(graph); got != "1,2" {
		t.Fatalf("nodes = %q, want both visible ones", got)
	}

	degrees := map[string]int{}
	for _, node := range graph.Nodes {
		degrees[node.Ref] = node.Degree
	}

	// Only the 1↔2 edge survives; the two edges into the masked node were dropped, and
	// counting them would make both notes look busier than the picture shows.
	if degrees["1"] != 1 || degrees["2"] != 1 {
		t.Fatalf("degrees = %v, want one apiece", degrees)
	}
}

// TestAnEdgeToNothingIsSkipped pins the defensive case: a link row whose endpoint was not
// in the node set at all — a note deleted between the two queries — must not produce an
// edge pointing at a ref that does not exist.
func TestAnEdgeToNothingIsSkipped(t *testing.T) {
	t.Parallel()

	nodes := []vault.GraphNode{visible(1), visible(2)}
	links := []vault.Link{{From: 1, To: 2}, {From: 1, To: 99}}

	graph := assembleGraph(nodes, index(1, 2), links, true)

	if len(graph.Edges) != 1 {
		t.Fatalf("edges = %v, want the dangling one dropped", graph.Edges)
	}
}

// TestKeptSubjectsSplitsByKind pins who survives a re-key. A subject missing from both
// lists loses the scope at every version, which is what makes a revocation retroactive.
func TestKeptSubjectsSplitsByKind(t *testing.T) {
	t.Parallel()

	users, groups := keptSubjects([]vault.RekeyGrant{
		{Subject: vault.Subject{Type: vault.SubjectUser, ID: 7}},
		{Subject: vault.Subject{Type: vault.SubjectGroup, ID: 3}},
		{Subject: vault.Subject{Type: vault.SubjectUser, ID: 9}},
		{Subject: vault.Subject{Type: vault.SubjectInvite, ID: 1}},
	})

	if len(users) != 2 || users[0] != 7 || users[1] != 9 {
		t.Fatalf("users = %v, want [7 9]", users)
	}

	if len(groups) != 1 || groups[0] != 3 {
		t.Fatalf("groups = %v, want [3]", groups)
	}
}

// TestKeptSubjectsNeverReturnsNil matters because both slices go straight into `= ANY($n)`:
// a nil there would delete nothing at all rather than everything, silently turning a
// revocation into a no-op.
func TestKeptSubjectsNeverReturnsNil(t *testing.T) {
	t.Parallel()

	users, groups := keptSubjects(nil)

	if users == nil || groups == nil {
		t.Fatalf("keptSubjects(nil) = %v, %v — a nil array would match nothing", users, groups)
	}
}
