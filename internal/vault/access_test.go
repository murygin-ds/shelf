package vault_test

import (
	"testing"

	"shelf/internal/vault"
)

func perm(p vault.Permission) *vault.Permission { return &p }

// inherit is a node with no explicit grant that passes the parent's permission down.
func inherit() vault.Node { return vault.Node{InheritAccess: true} }

// cut is a node whose access was detached from its parent.
func cut() vault.Node { return vault.Node{InheritAccess: false} }

// granted is a node carrying an explicit grant for the caller.
func granted(p vault.Permission) vault.Node {
	return vault.Node{Explicit: perm(p), InheritAccess: true}
}

func TestRoleFloor(t *testing.T) {
	t.Parallel()

	cases := map[vault.Role]vault.Permission{
		vault.RoleOwner:        vault.PermOwn,
		vault.RoleAdmin:        vault.PermOwn,
		vault.RoleEditor:       vault.PermEdit,
		vault.RoleViewer:       vault.PermView,
		vault.Role("nonsense"): vault.PermNone,
	}

	for role, want := range cases {
		t.Run(string(role), func(t *testing.T) {
			t.Parallel()

			if got := role.Floor(); got != want {
				t.Fatalf("Floor() = %q, want %q", got, want)
			}
		})
	}
}

func TestPermissionOrder(t *testing.T) {
	t.Parallel()

	ordered := []vault.Permission{
		vault.PermNone,
		vault.PermView,
		vault.PermComment,
		vault.PermEdit,
		vault.PermOwn,
	}

	for i, lower := range ordered {
		for _, higher := range ordered[i:] {
			if !higher.AtLeast(lower) {
				t.Fatalf("%q.AtLeast(%q) = false, want true", higher, lower)
			}
		}
	}

	if vault.PermNone.Allowed() {
		t.Fatal("PermNone.Allowed() = true, want false")
	}

	if !vault.PermView.Allowed() {
		t.Fatal("PermView.Allowed() = false, want true")
	}
}

func TestResolve(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		floor vault.Permission
		chain []vault.Node
		want  vault.Permission
	}{
		"vault root without folders is the role floor": {
			floor: vault.PermEdit,
			chain: nil,
			want:  vault.PermEdit,
		},
		"inheriting folders pass the floor down untouched": {
			floor: vault.PermEdit,
			chain: []vault.Node{inherit(), inherit(), inherit()},
			want:  vault.PermEdit,
		},
		"a grant on a folder replaces the floor": {
			floor: vault.PermView,
			chain: []vault.Node{granted(vault.PermEdit)},
			want:  vault.PermEdit,
		},
		"a grant can narrow below the floor": {
			floor: vault.PermEdit,
			chain: []vault.Node{granted(vault.PermView)},
			want:  vault.PermView,
		},
		"the nearest ancestor wins": {
			floor: vault.PermView,
			chain: []vault.Node{granted(vault.PermOwn), granted(vault.PermComment), inherit()},
			want:  vault.PermComment,
		},
		"cutting inheritance drops the floor": {
			floor: vault.PermOwn,
			chain: []vault.Node{cut()},
			want:  vault.PermNone,
		},
		"a cut folder can still grant explicitly": {
			floor: vault.PermNone,
			chain: []vault.Node{{Explicit: perm(vault.PermEdit), InheritAccess: false}},
			want:  vault.PermEdit,
		},
		"a cut below a grant hides the subtree again": {
			floor: vault.PermView,
			chain: []vault.Node{granted(vault.PermEdit), cut()},
			want:  vault.PermNone,
		},
		"an explicit deny stops the descent": {
			floor: vault.PermEdit,
			chain: []vault.Node{granted(vault.PermNone), inherit()},
			want:  vault.PermNone,
		},
		"a note grant overrides its folder": {
			floor: vault.PermView,
			chain: []vault.Node{granted(vault.PermNone), granted(vault.PermEdit)},
			want:  vault.PermEdit,
		},
		"a note deny overrides a permissive folder": {
			floor: vault.PermOwn,
			chain: []vault.Node{inherit(), granted(vault.PermNone)},
			want:  vault.PermNone,
		},
		"no membership means no access anywhere": {
			floor: vault.PermNone,
			chain: []vault.Node{inherit(), inherit()},
			want:  vault.PermNone,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if got := vault.Resolve(tc.floor, tc.chain); got != tc.want {
				t.Fatalf("Resolve() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBestGrant(t *testing.T) {
	t.Parallel()

	user := func(p vault.Permission) vault.Grant {
		return vault.Grant{Subject: vault.Subject{Type: vault.SubjectUser, ID: 1}, Permission: p}
	}
	group := func(id int64, p vault.Permission) vault.Grant {
		return vault.Grant{Subject: vault.Subject{Type: vault.SubjectGroup, ID: id}, Permission: p}
	}

	cases := map[string]struct {
		grants []vault.Grant
		want   vault.Permission
		found  bool
	}{
		"no grants at all": {
			grants: nil,
			want:   vault.PermNone,
			found:  false,
		},
		"a single group grant applies": {
			grants: []vault.Grant{group(7, vault.PermComment)},
			want:   vault.PermComment,
			found:  true,
		},
		"the most permissive group wins": {
			grants: []vault.Grant{group(7, vault.PermView), group(8, vault.PermEdit)},
			want:   vault.PermEdit,
			found:  true,
		},
		"a direct grant outranks a more permissive group": {
			grants: []vault.Grant{group(7, vault.PermOwn), user(vault.PermView)},
			want:   vault.PermView,
			found:  true,
		},
		// The reason direct beats group rather than merely competing with it: removing
		// one person from a shared folder has to be possible without disbanding the group.
		"a direct deny survives a generous group": {
			grants: []vault.Grant{group(7, vault.PermEdit), user(vault.PermNone)},
			want:   vault.PermNone,
			found:  true,
		},
		"order does not matter": {
			grants: []vault.Grant{user(vault.PermNone), group(7, vault.PermEdit)},
			want:   vault.PermNone,
			found:  true,
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, found := vault.BestGrant(tc.grants)

			if found != tc.found {
				t.Fatalf("found = %v, want %v", found, tc.found)
			}

			if got != tc.want {
				t.Fatalf("BestGrant() = %q, want %q", got, tc.want)
			}
		})
	}
}
