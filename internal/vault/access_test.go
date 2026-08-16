package vault_test

import (
	"testing"

	"shelf/internal/vault"
	"shelf/internal/vault/accesscases"
)

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

	// The same table the integration test drives against Postgres. Keeping one copy is the
	// point: two independent implementations of one rule that nobody compares would be free
	// to drift, and for this rule drifting means quietly widening access.
	for name, tc := range accesscases.Resolution {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			if got := vault.Resolve(tc.Role.Floor(), tc.Nodes()); got != tc.Want {
				t.Fatalf("Resolve() = %q, want %q", got, tc.Want)
			}
		})
	}
}

// TestResolveEdges covers the shapes the shared table cannot express, because they are not
// a tree anybody could seed: a chain of no nodes at all, and a member with no role.
func TestResolveEdges(t *testing.T) {
	t.Parallel()

	if got := vault.Resolve(vault.PermEdit, nil); got != vault.PermEdit {
		t.Fatalf("an empty chain resolved to %q, want the floor %q", got, vault.PermEdit)
	}

	chain := []vault.Node{{InheritAccess: true}, {InheritAccess: true}}

	if got := vault.Resolve(vault.PermNone, chain); got != vault.PermNone {
		t.Fatalf("no membership resolved to %q, want %q", got, vault.PermNone)
	}
}

func TestBestGrant(t *testing.T) {
	t.Parallel()

	for name, tc := range accesscases.Tiebreak {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			got, found := vault.BestGrant(tc.Grants())

			if !found {
				t.Fatal("found = false, want true")
			}

			if got != tc.Want {
				t.Fatalf("BestGrant() = %q, want %q", got, tc.Want)
			}
		})
	}
}

func TestBestGrantWithNothingToPick(t *testing.T) {
	t.Parallel()

	got, found := vault.BestGrant(nil)

	if found {
		t.Fatal("found = true for an empty grant list, want false")
	}

	if got != vault.PermNone {
		t.Fatalf("BestGrant(nil) = %q, want %q", got, vault.PermNone)
	}
}

// TestBestGrantIgnoresOrder pins that the answer is a property of the set, not of the
// order rows happened to come back in.
func TestBestGrantIgnoresOrder(t *testing.T) {
	t.Parallel()

	direct := vault.Grant{Subject: vault.Subject{Type: vault.SubjectUser, ID: 1}, Permission: vault.PermNone}
	group := vault.Grant{Subject: vault.Subject{Type: vault.SubjectGroup, ID: 7}, Permission: vault.PermEdit}

	first, _ := vault.BestGrant([]vault.Grant{direct, group})
	second, _ := vault.BestGrant([]vault.Grant{group, direct})

	if first != vault.PermNone || second != vault.PermNone {
		t.Fatalf("order changed the answer: %q then %q", first, second)
	}
}
