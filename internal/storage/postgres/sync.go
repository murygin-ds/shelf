package postgres

import (
	"context"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

// Sync returns every change after the cursor, stopping at a change-sequence boundary.
//
// The page is bounded by a sequence rather than by a row count on purpose: several rows
// can share one sequence (trashing a subtree writes them together), and a page that cut
// through the middle of one would leave the client with a cursor past changes it never
// received. The limit is therefore soft — one oversized batch is delivered whole.
func (r *VaultRepository) Sync(
	ctx context.Context,
	vaultID, userID, cursor int64,
	limit int,
) (*vault.Delta, error) {
	boundary, latest, err := r.syncBoundary(ctx, vaultID, cursor, limit)
	if err != nil {
		return nil, err
	}

	delta := &vault.Delta{Cursor: boundary, HasMore: boundary < latest}

	if boundary <= cursor {
		// Nothing new. Keep the caller's cursor rather than winding it back.
		delta.Cursor = cursor

		return delta, nil
	}

	if delta.Folders, err = r.syncFolders(ctx, vaultID, userID, cursor, boundary); err != nil {
		return nil, err
	}

	if delta.Files, err = r.syncFiles(ctx, vaultID, userID, cursor, boundary); err != nil {
		return nil, err
	}

	if delta.Purged, err = r.syncPurged(ctx, vaultID, cursor, boundary); err != nil {
		return nil, err
	}

	return delta, nil
}

// syncBoundary finds the highest change sequence that fits in the page, and the vault's
// current sequence so the caller can tell whether more is waiting.
func (r *VaultRepository) syncBoundary(
	ctx context.Context,
	vaultID, cursor int64,
	limit int,
) (boundary, latest int64, err error) {
	const query = `
		SELECT COALESCE((
		    SELECT max(updated_seq) FROM (
		        SELECT updated_seq FROM folders WHERE vault_id = $1 AND updated_seq > $2
		        UNION ALL
		        SELECT updated_seq FROM files WHERE vault_id = $1 AND updated_seq > $2
		        UNION ALL
		        SELECT purged_seq FROM purged_entities WHERE vault_id = $1 AND purged_seq > $2
		        ORDER BY 1
		        LIMIT $3
		    ) page
		), $2),
		(SELECT change_seq FROM vaults WHERE id = $1)`

	err = r.pool.QueryRow(ctx, query, vaultID, cursor, limit).Scan(&boundary, &latest)
	if err != nil {
		return 0, 0, fmt.Errorf("resolve sync boundary: %w", err)
	}

	return boundary, latest, nil
}

func (r *VaultRepository) syncFolders(
	ctx context.Context,
	vaultID, userID, cursor, boundary int64,
) ([]vault.Folder, error) {
	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + folderColumns + `,
		       fa.perm,
		       (ks.scope_type = 'folder' AND ks.scope_ref_id = f.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM folders f
		  JOIN folder_access fa ON fa.id = f.id
		  JOIN key_scopes ks ON ks.id = f.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = f.key_scope_id
		 WHERE f.vault_id = $1
		   AND permission_rank(fa.perm) > 0
		   AND f.updated_seq > $3 AND f.updated_seq <= $4
		 ORDER BY f.updated_seq, f.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, cursor, boundary)
	if err != nil {
		return nil, fmt.Errorf("select changed folders: %w", err)
	}
	defer rows.Close()

	return collect(rows, scanFolderRow)
}

func (r *VaultRepository) syncFiles(
	ctx context.Context,
	vaultID, userID, cursor, boundary int64,
) ([]vault.File, error) {
	query := accessCTE + `,` + scopeGrantCounts + `
		SELECT ` + fileColumns + `,
		       octet_length(fi.content),
		       fia.perm,
		       (ks.scope_type = 'file' AND ks.scope_ref_id = fi.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM files fi
		  JOIN file_access fia ON fia.id = fi.id
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  LEFT JOIN scope_grants sg ON sg.scope_id = fi.key_scope_id
		 WHERE fi.vault_id = $1
		   AND permission_rank(fia.perm) > 0
		   AND fi.updated_seq > $3 AND fi.updated_seq <= $4
		 ORDER BY fi.updated_seq, fi.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID, cursor, boundary)
	if err != nil {
		return nil, fmt.Errorf("select changed files: %w", err)
	}
	defer rows.Close()

	return collect(rows, scanFileRow)
}

// syncPurged is not filtered by permission: the row is gone, so there is nothing left to
// resolve a permission against, and the id alone tells the client only what it already had.
func (r *VaultRepository) syncPurged(
	ctx context.Context,
	vaultID, cursor, boundary int64,
) (vault.Purged, error) {
	const query = `
		SELECT entity_type, entity_id
		  FROM purged_entities
		 WHERE vault_id = $1 AND purged_seq > $2 AND purged_seq <= $3
		 ORDER BY purged_seq, id`

	rows, err := r.pool.Query(ctx, query, vaultID, cursor, boundary)
	if err != nil {
		return vault.Purged{}, fmt.Errorf("select purged entities: %w", err)
	}
	defer rows.Close()

	purged := vault.Purged{Folders: []int64{}, Files: []int64{}}

	for rows.Next() {
		var kind string
		var id int64

		if err := rows.Scan(&kind, &id); err != nil {
			return vault.Purged{}, fmt.Errorf("scan purged entity: %w", err)
		}

		if kind == "folder" {
			purged.Folders = append(purged.Folders, id)
		} else {
			purged.Files = append(purged.Files, id)
		}
	}

	if err := rows.Err(); err != nil {
		return vault.Purged{}, fmt.Errorf("iterate purged entities: %w", err)
	}

	return purged, nil
}

func collect[T any](rows pgx.Rows, scan func(pgx.Row) (*T, error)) ([]T, error) {
	out := make([]T, 0)

	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, *item)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rows: %w", err)
	}

	return out, nil
}
