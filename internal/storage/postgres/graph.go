package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

// ReplaceLinks makes a note's outgoing links exactly the given set.
//
// Targets the author cannot see are dropped by the insert itself. A link to a note the
// writer never had is not a resolved wikilink — it is a guessed id, and storing it would
// let one member probe the vault through another member's graph.
func (r *VaultRepository) ReplaceLinks(ctx context.Context, fileID, userID int64, to []int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		vaultID, err := fileVaultTx(ctx, tx, fileID)
		if err != nil {
			return err
		}

		// Only the links this caller could have resolved are replaced. A reader who holds
		// no key for some target sees it as an unreadable row and would never write the
		// link — deleting it here would let one member quietly erase another's edges
		// simply by saving the note.
		clear := accessCTE + `
			DELETE FROM note_links nl
			 USING file_access fia
			 WHERE nl.from_file_id = $3 AND fia.id = nl.to_file_id
			   AND permission_rank(fia.perm) > 0`

		if _, err := tx.Exec(ctx, clear, vaultID, userID, fileID); err != nil {
			return fmt.Errorf("clear links: %w", err)
		}

		if len(to) == 0 {
			return nil
		}

		insert := accessCTE + `
			INSERT INTO note_links (vault_id, from_file_id, to_file_id, created_by)
			SELECT $1, $3, fia.id, $2
			  FROM file_access fia
			 WHERE fia.id = ANY($4) AND fia.id <> $3 AND permission_rank(fia.perm) > 0
			ON CONFLICT (from_file_id, to_file_id) DO NOTHING`

		if _, err := tx.Exec(ctx, insert, vaultID, userID, fileID, to); err != nil {
			return fmt.Errorf("insert links: %w", err)
		}

		return nil
	})
}

// Backlinks lists what points at a note and counts what points at it out of sight.
//
// The hidden count is deliberate: it says "somebody you cannot see refers to this" without
// saying who. Reporting nothing would be a lie about the note's reach; reporting the ids
// would hand out notes every other route answers 404 for.
func (r *VaultRepository) Backlinks(ctx context.Context, fileID, userID int64) (*vault.Backlinks, error) {
	vaultID, err := r.fileVault(ctx, fileID)
	if err != nil {
		return nil, err
	}

	visible := accessCTE + "," + scopeGrantCounts + `
		SELECT ` + fileColumns + `,
		       octet_length(fi.content),
		       fia.perm,
		       (ks.scope_type = 'file' AND ks.scope_ref_id = fi.id) AS own_scope,
		       COALESCE(sg.grant_count, 0)
		  FROM note_links nl
		  JOIN files fi ON fi.id = nl.from_file_id
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  JOIN file_access fia ON fia.id = fi.id
		  LEFT JOIN scope_grants sg ON sg.scope_id = fi.key_scope_id
		 WHERE nl.to_file_id = $3 AND fi.deleted_at IS NULL
		   AND permission_rank(fia.perm) > 0
		 ORDER BY fi.id`

	rows, err := r.pool.Query(ctx, visible, vaultID, userID, fileID)
	if err != nil {
		return nil, fmt.Errorf("select backlinks: %w", err)
	}
	defer rows.Close()

	found := vault.Backlinks{Visible: make([]vault.File, 0)}

	for rows.Next() {
		file, err := scanFileRow(rows)
		if err != nil {
			return nil, err
		}

		found.Visible = append(found.Visible, *file)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate backlinks: %w", err)
	}

	hidden := accessCTE + `
		SELECT count(*)
		  FROM note_links nl
		  JOIN files fi ON fi.id = nl.from_file_id
		  LEFT JOIN file_access fia ON fia.id = fi.id
		 WHERE nl.to_file_id = $3 AND fi.deleted_at IS NULL
		   AND (fia.id IS NULL OR permission_rank(fia.perm) = 0)`

	if err := r.pool.QueryRow(ctx, hidden, vaultID, userID, fileID).Scan(&found.Hidden); err != nil {
		return nil, fmt.Errorf("count hidden backlinks: %w", err)
	}

	return &found, nil
}

// Graph draws the vault's link structure as one caller sees it.
//
// Nodes the caller cannot open are included as masked placeholders when the vault allows
// it, because a graph that silently drops them draws a picture that is wrong: notes would
// appear unconnected when they are not. They carry no file id — only a position in this
// response — so the picture reveals shape without handing out ids to probe.
func (r *VaultRepository) Graph(ctx context.Context, vaultID, userID int64) (*vault.Graph, error) {
	var revealsLocked bool

	const setting = `SELECT graph_reveals_locked FROM vaults WHERE id = $1`

	if err := r.pool.QueryRow(ctx, setting, vaultID).Scan(&revealsLocked); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("read graph setting: %w", err)
	}

	nodes, byID, err := r.graphNodes(ctx, vaultID, userID)
	if err != nil {
		return nil, err
	}

	edges, err := r.graphEdges(ctx, vaultID)
	if err != nil {
		return nil, err
	}

	return assembleGraph(nodes, byID, edges, revealsLocked), nil
}

func (r *VaultRepository) graphNodes(
	ctx context.Context,
	vaultID, userID int64,
) ([]vault.GraphNode, map[int64]int, error) {
	// Every note in the vault, with the ciphertext attached only where the caller may
	// read it. The LEFT JOIN is what lets one query answer both halves: a row with a null
	// permission is a note that exists and is not theirs.
	query := accessCTE + `
		SELECT fi.id, fi.client_id, fi.folder_id, fi.key_scope_id, ks.client_id, fi.key_version,
		       fi.meta, fi.meta_nonce,
		       COALESCE(permission_rank(fia.perm), 0) > 0 AS visible
		  FROM files fi
		  JOIN key_scopes ks ON ks.id = fi.key_scope_id
		  LEFT JOIN file_access fia ON fia.id = fi.id
		 WHERE fi.vault_id = $1 AND fi.deleted_at IS NULL
		 ORDER BY fi.id`

	rows, err := r.pool.Query(ctx, query, vaultID, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("select graph nodes: %w", err)
	}
	defer rows.Close()

	nodes := make([]vault.GraphNode, 0)
	byID := make(map[int64]int)

	for rows.Next() {
		var (
			node      vault.GraphNode
			id        int64
			folderID  *int64
			scopeID   int64
			scopeUUID string
			version   int32
			meta      vault.Blob
			visible   bool
		)

		err := rows.Scan(&id, &node.ClientID, &folderID, &scopeID, &scopeUUID, &version,
			&meta.Ciphertext, &meta.Nonce, &visible)
		if err != nil {
			return nil, nil, fmt.Errorf("scan graph node: %w", err)
		}

		if visible {
			node.Ref = strconv.FormatInt(id, 10)
			node.FileID = id
			node.FolderID = folderID
			node.KeyScopeID = scopeID
			node.KeyScopeClientID = scopeUUID
			node.KeyVersion = version
			node.Meta = &meta
		} else {
			// Nothing of the row survives but its existence, and even that only if some
			// visible note turns out to point at it.
			node.ClientID = ""
			node.Locked = true
		}

		byID[id] = len(nodes)
		nodes = append(nodes, node)
	}

	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate graph nodes: %w", err)
	}

	return nodes, byID, nil
}

func (r *VaultRepository) graphEdges(ctx context.Context, vaultID int64) ([]vault.Link, error) {
	const query = `
		SELECT nl.from_file_id, nl.to_file_id
		  FROM note_links nl
		  JOIN files a ON a.id = nl.from_file_id AND a.deleted_at IS NULL
		  JOIN files b ON b.id = nl.to_file_id AND b.deleted_at IS NULL
		 WHERE nl.vault_id = $1
		 ORDER BY nl.from_file_id, nl.to_file_id`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select graph edges: %w", err)
	}
	defer rows.Close()

	links := make([]vault.Link, 0)

	for rows.Next() {
		var link vault.Link

		if err := rows.Scan(&link.From, &link.To); err != nil {
			return nil, fmt.Errorf("scan graph edge: %w", err)
		}

		links = append(links, link)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate graph edges: %w", err)
	}

	return links, nil
}

// assembleGraph turns rows into the picture one caller gets. When the vault keeps masked
// nodes to itself, they and every edge touching them are dropped here rather than in SQL,
// so the two answers come from one query and cannot drift apart.
func assembleGraph(
	nodes []vault.GraphNode,
	byID map[int64]int,
	links []vault.Link,
	revealsLocked bool,
) *vault.Graph {
	graph := vault.Graph{
		Nodes:         make([]vault.GraphNode, 0, len(nodes)),
		Edges:         make([]vault.GraphEdge, 0, len(links)),
		RevealsLocked: revealsLocked,
	}

	kept := make([]vault.Link, 0, len(links))
	degree := make(map[int]int, len(nodes))

	for _, link := range links {
		from, okFrom := byID[link.From]
		to, okTo := byID[link.To]

		if !okFrom || !okTo {
			continue
		}

		bothMasked := nodes[from].Locked && nodes[to].Locked

		// An edge between two notes the caller cannot open would draw a private cluster
		// that has nothing to do with them — and give every node in it a degree, which is
		// what keeps a masked node in the answer at all.
		if bothMasked {
			continue
		}

		if !revealsLocked && (nodes[from].Locked || nodes[to].Locked) {
			continue
		}

		kept = append(kept, link)
		degree[from]++
		degree[to]++
	}

	// Visible nodes first, then the masked ones. The rows arrive ordered by file id, so
	// leaving a masked node in place would put it between two known ids and give away
	// roughly which note it is; numbering it only after the order is broken removes both
	// the position and the count of the ones that were dropped.
	ref := make(map[int]string, len(nodes))

	for index, node := range nodes {
		if node.Locked {
			continue
		}

		ref[index] = node.Ref
		node.Degree = degree[index]
		graph.Nodes = append(graph.Nodes, node)
	}

	masked := 0

	for index, node := range nodes {
		// A masked node nothing visible points at says only that another note exists,
		// which is a count the caller has no business receiving.
		if !node.Locked || degree[index] == 0 {
			continue
		}

		masked++
		node.Ref = "locked-" + strconv.Itoa(masked)
		node.Degree = degree[index]

		ref[index] = node.Ref
		graph.Locked++
		graph.Nodes = append(graph.Nodes, node)
	}

	for _, link := range kept {
		from, to := ref[byID[link.From]], ref[byID[link.To]]
		if from == "" || to == "" {
			continue
		}

		graph.Edges = append(graph.Edges, vault.GraphEdge{From: from, To: to})
	}

	return &graph
}
