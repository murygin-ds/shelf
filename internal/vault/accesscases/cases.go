// Package accesscases holds the truth table of the permission model.
//
// It exists as an importable package rather than a test file because two independent
// implementations have to agree on it: vault.Resolve in Go, and the recursive CTE in the
// storage layer. A table that lived inside one test could only ever check one of them, and
// the two would be free to drift — which for this particular rule means silently widening
// access everywhere at once.
//
// Nothing in the running service imports this.
package accesscases

import "shelf/internal/vault"

// Node is one step of the chain from the vault root down to the target, in the shape both
// implementations have to reproduce: the last element is the note, the ones before it are
// the folders above it.
type Node struct {
	// Grant is the explicit permission on this node, or nil when there is none.
	Grant *vault.Permission
	// Inherits false detaches this node from its parent.
	Inherits bool
}

// Case is one shape of the tree and the permission it must resolve to.
type Case struct {
	// Role sets the floor under every node of the vault.
	Role  vault.Role
	Chain []Node
	Want  vault.Permission
}

// Chain converts the case into the form vault.Resolve takes.
func (c Case) Nodes() []vault.Node {
	out := make([]vault.Node, 0, len(c.Chain))

	for _, node := range c.Chain {
		out = append(out, vault.Node{Explicit: node.Grant, InheritAccess: node.Inherits})
	}

	return out
}

func at(p vault.Permission) *vault.Permission { return &p }

// inherits is a node with no explicit grant that passes the parent's permission down.
func inherits() Node { return Node{Inherits: true} }

// cut is a node detached from its parent.
func cut() Node { return Node{Inherits: false} }

// granted is a node carrying an explicit grant for the caller.
func granted(p vault.Permission) Node { return Node{Grant: at(p), Inherits: true} }

// Resolution is the table. Every case is a real shape: a member with a role, some nested
// folders, and a note at the bottom.
//
// The chain always ends at the note, so every case here is at least one node long — a
// permission on nothing is not a question either implementation can answer.
var Resolution = map[string]Case{
	"a note at the root inherits the role floor": {
		Role:  vault.RoleEditor,
		Chain: []Node{inherits()},
		Want:  vault.PermEdit,
	},
	"inheriting folders pass the floor down untouched": {
		Role:  vault.RoleEditor,
		Chain: []Node{inherits(), inherits(), inherits()},
		Want:  vault.PermEdit,
	},
	"a grant on a folder replaces the floor": {
		Role:  vault.RoleViewer,
		Chain: []Node{granted(vault.PermEdit), inherits()},
		Want:  vault.PermEdit,
	},
	"a grant can narrow below the floor": {
		Role:  vault.RoleEditor,
		Chain: []Node{granted(vault.PermView), inherits()},
		Want:  vault.PermView,
	},
	"the nearest ancestor wins": {
		Role:  vault.RoleViewer,
		Chain: []Node{granted(vault.PermOwn), granted(vault.PermComment), inherits()},
		Want:  vault.PermComment,
	},
	"cutting inheritance drops the floor": {
		Role:  vault.RoleOwner,
		Chain: []Node{cut(), inherits()},
		Want:  vault.PermNone,
	},
	"a cut folder can still grant explicitly": {
		Role:  vault.RoleViewer,
		Chain: []Node{{Grant: at(vault.PermEdit), Inherits: false}, inherits()},
		Want:  vault.PermEdit,
	},
	"a cut below a grant hides the subtree again": {
		Role:  vault.RoleViewer,
		Chain: []Node{granted(vault.PermEdit), cut(), inherits()},
		Want:  vault.PermNone,
	},
	"an explicit deny stops the descent": {
		Role:  vault.RoleEditor,
		Chain: []Node{granted(vault.PermNone), inherits(), inherits()},
		Want:  vault.PermNone,
	},
	"a note grant overrides its folder": {
		Role:  vault.RoleViewer,
		Chain: []Node{granted(vault.PermNone), granted(vault.PermEdit)},
		Want:  vault.PermEdit,
	},
	"a note deny overrides a permissive folder": {
		Role:  vault.RoleOwner,
		Chain: []Node{inherits(), granted(vault.PermNone)},
		Want:  vault.PermNone,
	},
	"a note may be cut from its folder": {
		Role:  vault.RoleAdmin,
		Chain: []Node{inherits(), cut()},
		Want:  vault.PermNone,
	},
	"a deep tree still carries the floor": {
		Role:  vault.RoleEditor,
		Chain: []Node{inherits(), inherits(), inherits(), inherits(), inherits(), inherits()},
		Want:  vault.PermEdit,
	},
	"a grant deep in the tree wins over the floor": {
		Role:  vault.RoleViewer,
		Chain: []Node{inherits(), inherits(), granted(vault.PermOwn), inherits()},
		Want:  vault.PermOwn,
	},
}

// Subjects is the second table: several grants landing on one node at once.
//
// It exists separately because the rule it pins — a grant addressed to a person outranks
// one reaching them through a group, whichever is more permissive — cannot be expressed as
// a chain. It is what lets one person be removed from a shared folder without disbanding
// the group.
type Subjects struct {
	// Direct is the caller's own grant on the node, or nil.
	Direct *vault.Permission
	// Groups are the grants reaching the caller through group membership.
	Groups []vault.Permission
	Want   vault.Permission
}

var Tiebreak = map[string]Subjects{
	"a single group grant applies": {
		Groups: []vault.Permission{vault.PermComment},
		Want:   vault.PermComment,
	},
	"the most permissive group wins": {
		Groups: []vault.Permission{vault.PermView, vault.PermEdit},
		Want:   vault.PermEdit,
	},
	"a direct grant outranks a more permissive group": {
		Direct: at(vault.PermView),
		Groups: []vault.Permission{vault.PermOwn},
		Want:   vault.PermView,
	},
	"a direct deny survives a generous group": {
		Direct: at(vault.PermNone),
		Groups: []vault.Permission{vault.PermEdit},
		Want:   vault.PermNone,
	},
	"a direct grant with no group at all": {
		Direct: at(vault.PermComment),
		Want:   vault.PermComment,
	},
}

// Grants converts a tiebreak case into the form vault.BestGrant takes.
func (s Subjects) Grants() []vault.Grant {
	out := make([]vault.Grant, 0, len(s.Groups)+1)

	for i, permission := range s.Groups {
		out = append(out, vault.Grant{
			Subject:    vault.Subject{Type: vault.SubjectGroup, ID: int64(i + 1)},
			Permission: permission,
		})
	}

	if s.Direct != nil {
		out = append(out, vault.Grant{
			Subject:    vault.Subject{Type: vault.SubjectUser, ID: 1},
			Permission: *s.Direct,
		})
	}

	return out
}
