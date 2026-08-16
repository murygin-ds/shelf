package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// accessCTE resolves the caller's effective permission for every folder and every note of
// one vault, top-down in a single pass. $1 is the vault id and $2 the user id.
//
// It is the SQL half of vault.Resolve, and the order it applies is the one the product
// spells out: the vault role sets the floor, a folder narrows it, and a single note
// overrides both. A grant addressed to the user directly outranks one reaching them
// through a group, which is what lets an explicit deny survive a generous group.
const accessCTE = `
WITH RECURSIVE subjects AS (
    SELECT 'user'::TEXT AS subject_type, $2::BIGINT AS subject_id
    UNION ALL
    SELECT 'group', gm.group_id FROM group_members gm WHERE gm.user_id = $2
),
vault_floor AS (
    SELECT COALESCE(
        (SELECT role_permission(vm.role) FROM vault_members vm
          WHERE vm.vault_id = $1 AND vm.user_id = $2),
        'none'
    ) AS perm
),
folder_grant AS (
    SELECT DISTINCT ON (g.scope_ref_id) g.scope_ref_id AS folder_id, g.permission
      FROM grants g
      JOIN subjects s ON s.subject_type = g.subject_type AND s.subject_id = g.subject_id
     WHERE g.vault_id = $1 AND g.scope_type = 'folder'
     ORDER BY g.scope_ref_id, (g.subject_type = 'user') DESC, permission_rank(g.permission) DESC
),
file_grant AS (
    SELECT DISTINCT ON (g.scope_ref_id) g.scope_ref_id AS file_id, g.permission
      FROM grants g
      JOIN subjects s ON s.subject_type = g.subject_type AND s.subject_id = g.subject_id
     WHERE g.vault_id = $1 AND g.scope_type = 'file'
     ORDER BY g.scope_ref_id, (g.subject_type = 'user') DESC, permission_rank(g.permission) DESC
),
folder_access AS (
    SELECT f.id, f.parent_id,
           COALESCE(fg.permission,
                    CASE WHEN f.inherit_access THEN (SELECT perm FROM vault_floor) ELSE 'none' END) AS perm
      FROM folders f
      LEFT JOIN folder_grant fg ON fg.folder_id = f.id
     WHERE f.vault_id = $1 AND f.parent_id IS NULL
    UNION ALL
    SELECT c.id, c.parent_id,
           COALESCE(fg.permission,
                    CASE WHEN c.inherit_access THEN t.perm ELSE 'none' END)
      FROM folders c
      JOIN folder_access t ON c.parent_id = t.id
      LEFT JOIN folder_grant fg ON fg.folder_id = c.id
),
file_access AS (
    SELECT fi.id,
           COALESCE(fig.permission,
                    CASE WHEN fi.inherit_access
                         THEN COALESCE(fa.perm, (SELECT perm FROM vault_floor))
                         ELSE 'none' END) AS perm
      FROM files fi
      LEFT JOIN folder_access fa ON fa.id = fi.folder_id
      LEFT JOIN file_grant fig ON fig.file_id = fi.id
     WHERE fi.vault_id = $1
)`

// scopeGrantCounts counts the subjects holding a key at each scope's current version. A
// count of one on a node that owns its scope is what the tree renders as a solo key.
const scopeGrantCounts = `
scope_grants AS (
    SELECT ks.id AS scope_id, count(kg.id) AS grant_count
      FROM key_scopes ks
      LEFT JOIN key_grants kg ON kg.scope_id = ks.id AND kg.key_version = ks.key_version
     WHERE ks.vault_id = $1
     GROUP BY ks.id
)`

// The aliased column lists are for the joined reads; the plain ones for RETURNING, where
// no alias is in scope. They must stay in the same order as their scan helpers.
const folderColumns = `f.id, f.client_id, f.vault_id, f.parent_id, ks.client_id, f.key_scope_id, f.key_version,
	f.meta, f.meta_nonce, f.inherit_access, f.depth, f.position,
	f.updated_seq, f.updated_by, f.deleted_at, f.created_at, f.updated_at`

const folderReturning = `id, client_id, vault_id, parent_id,
	(SELECT client_id FROM key_scopes WHERE id = folders.key_scope_id), key_scope_id, key_version,
	meta, meta_nonce, inherit_access, depth, position,
	updated_seq, updated_by, deleted_at, created_at, updated_at`

const fileColumns = `fi.id, fi.client_id, fi.vault_id, fi.folder_id, ks.client_id, fi.key_scope_id, fi.key_version,
	fi.meta, fi.meta_nonce, fi.content_seq, fi.inherit_access,
	fi.updated_seq, fi.updated_by, fi.deleted_at, fi.created_at, fi.updated_at`

// fileBodyColumns adds the note body. Only the single read and the bulk hydration select
// it; the tree stays cheap on purpose.
const fileBodyColumns = fileColumns + `, fi.content, fi.content_nonce, octet_length(fi.content)`

const fileReturning = `id, client_id, vault_id, folder_id,
	(SELECT client_id FROM key_scopes WHERE id = files.key_scope_id), key_scope_id, key_version,
	meta, meta_nonce, content_seq, inherit_access,
	updated_seq, updated_by, deleted_at, created_at, updated_at,
	content, content_nonce, octet_length(content)`

// inTx runs fn inside a transaction, rolling back on any error.
func inTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}

	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(tx); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	return nil
}

// nextSeq allocates the vault's next change sequence. Calling it inside the same
// transaction as the write is what keeps the sync cursor gap-free.
func nextSeq(ctx context.Context, tx pgx.Tx, vaultID int64) (int64, error) {
	var seq int64
	if err := tx.QueryRow(ctx, `SELECT next_vault_seq($1)`, vaultID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("allocate change sequence: %w", err)
	}

	return seq, nil
}
