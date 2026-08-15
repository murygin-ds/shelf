package vault

// Role is the membership level in a vault. It sets the floor under every node a member
// can reach; grants narrow or widen it from there.
type Role string

const (
	RoleOwner  Role = "owner"
	RoleAdmin  Role = "admin"
	RoleEditor Role = "editor"
	RoleViewer Role = "viewer"
)

// Permission is the effective right on one node.
type Permission string

const (
	PermNone    Permission = "none"
	PermView    Permission = "view"
	PermComment Permission = "comment"
	PermEdit    Permission = "edit"
	PermOwn     Permission = "own"
)

// SubjectType is what a grant is addressed to.
type SubjectType string

const (
	SubjectUser      SubjectType = "user"
	SubjectGroup     SubjectType = "group"
	SubjectInvite    SubjectType = "invite"
	SubjectShareLink SubjectType = "share_link"
)

// Subject identifies the holder of a grant.
type Subject struct {
	Type SubjectType
	ID   int64
}

// Grant is one explicit permission entry on a node.
type Grant struct {
	Subject    Subject
	Permission Permission
}

// Node is one step of the chain that runs from the vault root down to the target.
type Node struct {
	// Explicit is the grant that applies to the caller on this node, if any.
	Explicit *Permission
	// InheritAccess false cuts the chain: nothing flows down from the parent.
	InheritAccess bool
}

var permissionRank = map[Permission]int{
	PermNone:    0,
	PermView:    1,
	PermComment: 2,
	PermEdit:    3,
	PermOwn:     4,
}

// Rank orders the lattice. It mirrors the permission_rank() SQL function, and the two are
// held together by the integration test that runs both over the same table.
func (p Permission) Rank() int { return permissionRank[p] }

// AtLeast reports whether p allows everything other allows.
func (p Permission) AtLeast(other Permission) bool { return p.Rank() >= other.Rank() }

// Allowed reports whether the permission grants anything at all.
func (p Permission) Allowed() bool { return p.Rank() > 0 }

// Floor is the permission a role puts under every node of the vault.
func (r Role) Floor() Permission {
	switch r {
	case RoleOwner, RoleAdmin:
		return PermOwn
	case RoleEditor:
		return PermEdit
	case RoleViewer:
		return PermView
	default:
		return PermNone
	}
}

// Manages reports whether the role may change membership and permissions.
func (r Role) Manages() bool { return r == RoleOwner || r == RoleAdmin }

// Valid reports whether the role is one this vault understands.
func (r Role) Valid() bool {
	switch r {
	case RoleOwner, RoleAdmin, RoleEditor, RoleViewer:
		return true
	default:
		return false
	}
}

// BestGrant picks the single grant that applies at one node.
//
// A grant addressed to the user directly outranks any grant reaching them through a group,
// which is what lets an explicit deny survive a generous group membership. Between grants
// of the same kind the most permissive one wins.
func BestGrant(grants []Grant) (Permission, bool) {
	best := PermNone
	found := false
	direct := false

	for _, grant := range grants {
		isDirect := grant.Subject.Type == SubjectUser

		switch {
		case !found, isDirect && !direct:
			best, found, direct = grant.Permission, true, isDirect
		case isDirect == direct && grant.Permission.Rank() > best.Rank():
			best = grant.Permission
		}
	}

	return best, found
}

// Resolve walks the chain from the vault root down to the target and returns the effective
// permission. It is the Go side of the recursive CTE in the storage layer; both are exercised
// by the same table of cases so they cannot drift apart.
//
// The order is the one the product spells out: the vault role sets the floor, a folder
// narrows it, and a single note overrides both.
func Resolve(floor Permission, chain []Node) Permission {
	effective := floor

	for _, node := range chain {
		switch {
		case node.Explicit != nil:
			effective = *node.Explicit
		case !node.InheritAccess:
			effective = PermNone
		}
	}

	return effective
}
