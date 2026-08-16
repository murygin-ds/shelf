//go:build integration

// The permission model is written twice: once as vault.Resolve in Go, and once as a
// recursive CTE in SQL. Only the SQL one gates a real read, and a fake cannot stand in for
// it — it leans on WITH RECURSIVE, DISTINCT ON and two functions that exist only in the
// migrations. So this file drives both over the same table and refuses to let them differ.
//
//	SHELF_TEST_POSTGRES_DSN=postgres://user@localhost:5432/shelf_test?sslmode=disable \
//	    go test -tags integration ./internal/storage/postgres/
package postgres

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"shelf/internal/vault"
	"shelf/internal/vault/accesscases"

	"github.com/jackc/pgx/v5/pgxpool"
)

const dsnEnv = "SHELF_TEST_POSTGRES_DSN"

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}

// connect prepares a database with the schema applied. It skips rather than fails when no
// DSN is configured: not every checkout has a Postgres to hand, and a test that fails for
// that reason teaches people to ignore it.
func connect(t *testing.T) *pgxpool.Pool {
	t.Helper()

	dsn := os.Getenv(dsnEnv)
	if dsn == "" {
		t.Skipf("set %s to run the integration tests", dsnEnv)
	}

	ctx := context.Background()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	t.Cleanup(pool.Close)

	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping: %v", err)
	}

	migrate(t, pool)

	return pool
}

// migrate applies every up migration in order. The .down.sql files run first so a rerun
// starts from nothing: these tests seed at fixed shapes and a leftover row from a previous
// run would make them pass or fail for reasons that have nothing to do with the code.
func migrate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	ctx := context.Background()
	root := filepath.Join("..", "..", "..", "migrations")

	apply := func(suffix string, reverse bool) {
		files, err := filepath.Glob(filepath.Join(root, "*"+suffix))
		if err != nil {
			t.Fatalf("list migrations: %v", err)
		}

		sort.Strings(files)

		if reverse {
			for i, j := 0, len(files)-1; i < j; i, j = i+1, j-1 {
				files[i], files[j] = files[j], files[i]
			}
		}

		for _, file := range files {
			statements, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}

			if _, err := pool.Exec(ctx, string(statements)); err != nil && !reverse {
				t.Fatalf("apply %s: %v", filepath.Base(file), err)
			}

			// A down migration may legitimately fail on a database that never had the
			// table; it may not fail on one that does. TestMigrationsAreReversible is
			// what checks that, by running down over a fully migrated schema.
		}
	}

	apply(".down.sql", true)
	apply(".up.sql", false)

	// schema_migrations belongs to the migrate CLI, not to us; dropping it keeps a test
	// database usable by the real tool afterwards.
	if _, err := pool.Exec(ctx, `DROP TABLE IF EXISTS schema_migrations`); err != nil {
		t.Fatalf("drop migrate bookkeeping: %v", err)
	}
}

// fixture is one seeded vault: an owner, a member under test, and whatever tree a case needs.
type fixture struct {
	pool    *pgxpool.Pool
	t       *testing.T
	vaultID int64
	scopeID int64
	ownerID int64
	userID  int64
}

func seed(t *testing.T, pool *pgxpool.Pool, role vault.Role) *fixture {
	t.Helper()

	ctx := context.Background()
	f := &fixture{pool: pool, t: t}

	f.ownerID = f.user("owner")
	f.userID = f.user("member")

	err := pool.QueryRow(ctx, `
		INSERT INTO vaults (client_id, owner_id, meta, meta_nonce)
		VALUES (gen_random_uuid(), $1, '\x00', '\x00') RETURNING id`, f.ownerID).Scan(&f.vaultID)
	if err != nil {
		t.Fatalf("insert vault: %v", err)
	}

	err = pool.QueryRow(ctx, `
		INSERT INTO key_scopes (client_id, vault_id, scope_type, scope_ref_id, key_version)
		VALUES (gen_random_uuid(), $1, 'vault', $1, 1) RETURNING id`, f.vaultID).Scan(&f.scopeID)
	if err != nil {
		t.Fatalf("insert scope: %v", err)
	}

	// A vault has exactly one owner, enforced by a partial unique index. When the case
	// under test is about an owner, the member IS the owner rather than a second one.
	if role == vault.RoleOwner {
		f.ownerID = f.userID
	}

	f.member(f.ownerID, vault.RoleOwner)

	if role != "" && f.userID != f.ownerID {
		f.member(f.userID, role)
	}

	return f
}

func (f *fixture) user(prefix string) int64 {
	f.t.Helper()

	var id int64

	// The login is unique per row so cases can seed freely without colliding.
	err := f.pool.QueryRow(context.Background(), `
		INSERT INTO users (login, display_name, auth_hash, kdf_salt, kdf_params,
		                   wrapped_master_key, master_key_nonce, public_key,
		                   wrapped_private_key, private_key_nonce)
		VALUES ($1 || '-' || gen_random_uuid() || '@test.invalid', $1, 'x', '\x00',
		        '{}'::JSONB, '\x00', '\x00', '\x00', '\x00', '\x00')
		RETURNING id`, prefix).Scan(&id)
	if err != nil {
		f.t.Fatalf("insert user: %v", err)
	}

	return id
}

func (f *fixture) member(userID int64, role vault.Role) {
	f.t.Helper()

	_, err := f.pool.Exec(context.Background(), `
		INSERT INTO vault_members (vault_id, user_id, role, key_state, access_seq)
		VALUES ($1, $2, $3, 'ok', 0)`, f.vaultID, userID, role)
	if err != nil {
		f.t.Fatalf("insert membership: %v", err)
	}
}

func (f *fixture) folder(parent *int64, depth int32, inherits bool) int64 {
	f.t.Helper()

	var id int64

	err := f.pool.QueryRow(context.Background(), `
		INSERT INTO folders (client_id, vault_id, parent_id, key_scope_id, key_version,
		                     meta, meta_nonce, inherit_access, depth, position, updated_seq)
		VALUES (gen_random_uuid(), $1, $2, $3, 1, '\x00', '\x00', $4, $5, 0, 0)
		RETURNING id`, f.vaultID, parent, f.scopeID, inherits, depth).Scan(&id)
	if err != nil {
		f.t.Fatalf("insert folder: %v", err)
	}

	return id
}

func (f *fixture) file(folder *int64, inherits bool) int64 {
	f.t.Helper()

	var id int64

	err := f.pool.QueryRow(context.Background(), `
		INSERT INTO files (client_id, vault_id, folder_id, key_scope_id, key_version,
		                   meta, meta_nonce, content, content_nonce, inherit_access, updated_seq)
		VALUES (gen_random_uuid(), $1, $2, $3, 1, '\x00', '\x00', '\x00', '\x00', $4, 0)
		RETURNING id`, f.vaultID, folder, f.scopeID, inherits).Scan(&id)
	if err != nil {
		f.t.Fatalf("insert file: %v", err)
	}

	return id
}

func (f *fixture) grant(scope vault.ScopeType, refID int64, subject vault.Subject, p vault.Permission) {
	f.t.Helper()

	_, err := f.pool.Exec(context.Background(), `
		INSERT INTO grants (vault_id, scope_type, scope_ref_id, subject_type, subject_id, permission)
		VALUES ($1, $2, $3, $4, $5, $6)`,
		f.vaultID, scope, refID, subject.Type, subject.ID, p)
	if err != nil {
		f.t.Fatalf("insert grant: %v", err)
	}
}

func (f *fixture) group(members ...int64) int64 {
	f.t.Helper()

	var id int64

	err := f.pool.QueryRow(context.Background(), `
		INSERT INTO groups (client_id, vault_id, meta, meta_nonce, public_key, key_version)
		VALUES (gen_random_uuid(), $1, '\x00', '\x00', '\x00', 1) RETURNING id`, f.vaultID).Scan(&id)
	if err != nil {
		f.t.Fatalf("insert group: %v", err)
	}

	for _, userID := range members {
		_, err := f.pool.Exec(context.Background(), `
			INSERT INTO group_members (group_id, user_id, key_version, wrapped_private_key, nonce)
			VALUES ($1, $2, 1, '\x00', '\x00')`, id, userID)
		if err != nil {
			f.t.Fatalf("insert group member: %v", err)
		}
	}

	return id
}

// resolved asks the production query what the member may do with the note. A note the
// query refuses to return is PermNone: that equivalence is the 404-not-403 rule, and it is
// part of what this test pins.
func resolved(t *testing.T, pool *pgxpool.Pool, fileID, userID int64) vault.Permission {
	t.Helper()

	// The row has to exist first. FileRef answers ErrNotFound for a missing note exactly as
	// it does for an invisible one, so without this every case expecting no access would
	// pass against a fixture that seeded nothing at all.
	var exists bool

	err := pool.QueryRow(context.Background(),
		`SELECT EXISTS (SELECT 1 FROM files WHERE id = $1)`, fileID).Scan(&exists)
	if err != nil {
		t.Fatalf("check the note exists: %v", err)
	}

	if !exists {
		t.Fatalf("the fixture never created note %d", fileID)
	}

	repo := NewVaultRepository(pool)

	ref, err := repo.FileRef(context.Background(), fileID, userID)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			return vault.PermNone
		}

		t.Fatalf("FileRef: %v", err)
	}

	return ref.Permission
}

// TestCTEMatchesResolve is the differential test the whole file exists for: the same shape
// through the SQL that guards production and through the Go function that documents it.
func TestCTEMatchesResolve(t *testing.T) {
	pool := connect(t)

	for name, tc := range accesscases.Resolution {
		t.Run(name, func(t *testing.T) {
			f := seed(t, pool, tc.Role)
			subject := vault.Subject{Type: vault.SubjectUser, ID: f.userID}

			var parent *int64

			// Everything but the last node is a folder; the last one is the note.
			for i, node := range tc.Chain[:len(tc.Chain)-1] {
				id := f.folder(parent, int32(i), node.Inherits)

				if node.Grant != nil {
					f.grant(vault.ScopeFolder, id, subject, *node.Grant)
				}

				parent = &id
			}

			last := tc.Chain[len(tc.Chain)-1]
			fileID := f.file(parent, last.Inherits)

			if last.Grant != nil {
				f.grant(vault.ScopeFile, fileID, subject, *last.Grant)
			}

			fromGo := vault.Resolve(tc.Role.Floor(), tc.Nodes())
			fromSQL := resolved(t, pool, fileID, f.userID)

			if fromGo != tc.Want {
				t.Fatalf("vault.Resolve = %q, want %q — the table and the Go model disagree", fromGo, tc.Want)
			}

			if fromSQL != tc.Want {
				t.Fatalf("accessCTE = %q, want %q — the SQL has drifted from the model", fromSQL, tc.Want)
			}
		})
	}
}

// TestCTEMatchesBestGrant pins the tiebreak: a grant addressed to a person outranks one
// reaching them through a group, which is what lets one member be removed from a shared
// folder without disbanding the group.
func TestCTEMatchesBestGrant(t *testing.T) {
	pool := connect(t)

	for name, tc := range accesscases.Tiebreak {
		t.Run(name, func(t *testing.T) {
			// The floor is deliberately the weakest role, so every answer below comes from
			// the grants rather than from membership.
			f := seed(t, pool, vault.RoleViewer)
			folderID := f.folder(nil, 0, true)
			fileID := f.file(&folderID, true)

			for _, permission := range tc.Groups {
				groupID := f.group(f.userID)
				f.grant(vault.ScopeFolder, folderID,
					vault.Subject{Type: vault.SubjectGroup, ID: groupID}, permission)
			}

			if tc.Direct != nil {
				f.grant(vault.ScopeFolder, folderID,
					vault.Subject{Type: vault.SubjectUser, ID: f.userID}, *tc.Direct)
			}

			fromGo, found := vault.BestGrant(tc.Grants())
			if !found || fromGo != tc.Want {
				t.Fatalf("vault.BestGrant = %q (found %v), want %q", fromGo, found, tc.Want)
			}

			if fromSQL := resolved(t, pool, fileID, f.userID); fromSQL != tc.Want {
				t.Fatalf("accessCTE = %q, want %q — the group tiebreak has drifted", fromSQL, tc.Want)
			}
		})
	}
}

// TestRoleFloorMatchesSQL pins role_permission against Role.Floor. They are two spellings
// of one mapping and nothing else compares them.
func TestRoleFloorMatchesSQL(t *testing.T) {
	pool := connect(t)
	ctx := context.Background()

	for _, role := range []vault.Role{
		vault.RoleOwner, vault.RoleAdmin, vault.RoleEditor, vault.RoleViewer, vault.Role("nonsense"),
	} {
		var got vault.Permission

		if err := pool.QueryRow(ctx, `SELECT role_permission($1)`, role).Scan(&got); err != nil {
			t.Fatalf("role_permission(%q): %v", role, err)
		}

		if want := role.Floor(); got != want {
			t.Fatalf("role_permission(%q) = %q, Role.Floor() = %q", role, got, want)
		}
	}
}

// TestPermissionRankMatchesSQL pins permission_rank against Permission.Rank. Every
// comparison in the CTE goes through it, so a disagreement here reorders the whole lattice.
func TestPermissionRankMatchesSQL(t *testing.T) {
	pool := connect(t)
	ctx := context.Background()

	for _, p := range []vault.Permission{
		vault.PermNone, vault.PermView, vault.PermComment, vault.PermEdit, vault.PermOwn,
	} {
		var got int

		if err := pool.QueryRow(ctx, `SELECT permission_rank($1)`, p).Scan(&got); err != nil {
			t.Fatalf("permission_rank(%q): %v", p, err)
		}

		if want := p.Rank(); got != want {
			t.Fatalf("permission_rank(%q) = %d, Permission.Rank() = %d", p, got, want)
		}
	}
}

// TestAStrangerSeesNothing is the other half of the model: someone with no membership at
// all resolves to nothing, and the note answers as though it did not exist.
func TestAStrangerSeesNothing(t *testing.T) {
	pool := connect(t)

	f := seed(t, pool, "")
	folderID := f.folder(nil, 0, true)
	fileID := f.file(&folderID, true)

	if got := resolved(t, pool, fileID, f.userID); got != vault.PermNone {
		t.Fatalf("a non-member resolved to %q, want %q", got, vault.PermNone)
	}

	// And the owner still sees it, so the case above is about membership rather than a
	// fixture that failed to seed anything at all.
	if got := resolved(t, pool, fileID, f.ownerID); got != vault.PermOwn {
		t.Fatalf("the owner resolved to %q, want %q", got, vault.PermOwn)
	}
}

// TestNextVaultSeqIsMonotonic pins the sequence the whole sync protocol rests on: it never
// repeats a number, even when writers collide.
func TestNextVaultSeqIsMonotonic(t *testing.T) {
	pool := connect(t)
	ctx := context.Background()

	f := seed(t, pool, vault.RoleEditor)

	const writers = 16

	seen := make(chan int64, writers)
	errs := make(chan error, writers)
	start := make(chan struct{})

	for range writers {
		go func() {
			// Every writer waits on the same channel, so they contend rather than queue up
			// politely behind one another and prove nothing about locking.
			<-start

			var seq int64

			if err := pool.QueryRow(ctx, `SELECT next_vault_seq($1)`, f.vaultID).Scan(&seq); err != nil {
				errs <- err
				return
			}

			seen <- seq
		}()
	}

	close(start)

	var (
		unique  = make(map[int64]bool, writers)
		highest int64
	)

	for range writers {
		select {
		case err := <-errs:
			t.Fatalf("next_vault_seq: %v", err)
		case seq := <-seen:
			if unique[seq] {
				t.Fatalf("next_vault_seq handed out %d twice — a sync cursor would skip a change", seq)
			}

			unique[seq] = true

			if seq > highest {
				highest = seq
			}
		case <-time.After(30 * time.Second):
			t.Fatal("next_vault_seq did not answer: the row lock is held somewhere")
		}
	}

	// Unique is not enough: the numbers also have to be a dense run, or a cursor that skips
	// to the highest one would step over a change that really happened.
	if highest != int64(writers) {
		t.Fatalf("highest sequence = %d after %d writers, want a dense run", highest, writers)
	}
}

// TestMigrationsAreReversible walks every migration down and up again. A down that does
// not undo its up turns a rollback into an outage, and nothing else here would notice.
func TestMigrationsAreReversible(t *testing.T) {
	pool := connect(t)
	ctx := context.Background()

	tables := func() []string {
		rows, err := pool.Query(ctx, `
			SELECT table_name FROM information_schema.tables
			 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
			 ORDER BY table_name`)
		if err != nil {
			t.Fatalf("list tables: %v", err)
		}
		defer rows.Close()

		var names []string

		for rows.Next() {
			var name string

			if err := rows.Scan(&name); err != nil {
				t.Fatalf("scan table: %v", err)
			}

			names = append(names, name)
		}

		return names
	}

	before := tables()

	if len(before) == 0 {
		t.Fatalf("no tables after migrating — %s points at the wrong database?", dsnEnv)
	}

	// Down first, and it has to actually empty the schema: comparing table names after a
	// full round trip would pass just as happily for a .down.sql that does nothing.
	root := filepath.Join("..", "..", "..", "migrations")

	downs, err := filepath.Glob(filepath.Join(root, "*.down.sql"))
	if err != nil {
		t.Fatalf("list down migrations: %v", err)
	}

	sort.Sort(sort.Reverse(sort.StringSlice(downs)))

	for _, file := range downs {
		statements, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}

		if _, err := pool.Exec(ctx, string(statements)); err != nil {
			t.Fatalf("roll back %s: %v", filepath.Base(file), err)
		}
	}

	if left := tables(); len(left) != 0 {
		t.Fatalf("rolling every migration back left %v behind", left)
	}

	migrate(t, pool)

	if after := tables(); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("schema differs after down+up:\n before %v\n after  %v", before, after)
	}
}
