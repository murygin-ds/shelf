package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/access"
	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

const groupColumns = `g.id, g.client_id, g.vault_id, g.meta, g.meta_nonce,
	g.public_key, g.key_version, g.created_by, g.created_at`

func (r *AccessRepository) Groups(ctx context.Context, vaultID int64) ([]access.Group, error) {
	query := `SELECT ` + groupColumns + ` FROM groups g WHERE g.vault_id = $1 ORDER BY g.id`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select groups: %w", err)
	}
	defer rows.Close()

	groups := make([]access.Group, 0)

	for rows.Next() {
		group, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}

		groups = append(groups, *group)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate groups: %w", err)
	}

	// One query for the members of every group, rather than one per group: a vault with a
	// dozen groups is ordinary and a dozen round trips for a list is not.
	if err := r.attachMembers(ctx, groups); err != nil {
		return nil, err
	}

	return groups, nil
}

func (r *AccessRepository) Group(ctx context.Context, groupID int64) (*access.Group, error) {
	query := `SELECT ` + groupColumns + ` FROM groups g WHERE g.id = $1`

	group, err := scanGroup(r.pool.QueryRow(ctx, query, groupID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, access.ErrNotFound
		}

		return nil, err
	}

	list := []access.Group{*group}
	if err := r.attachMembers(ctx, list); err != nil {
		return nil, err
	}

	return &list[0], nil
}

// attachMembers fills in who is in each group, with the display fields a member table
// needs. The wrapped key travels too: it is only useful to the person it was sealed to.
func (r *AccessRepository) attachMembers(ctx context.Context, groups []access.Group) error {
	if len(groups) == 0 {
		return nil
	}

	ids := make([]int64, 0, len(groups))
	at := make(map[int64]int, len(groups))

	for i, group := range groups {
		ids = append(ids, group.ID)
		at[group.ID] = i
		groups[i].Members = make([]access.GroupMember, 0)
	}

	const query = `
		SELECT gm.group_id, gm.user_id, u.login, u.display_name, u.public_key,
		       gm.key_version, gm.wrapped_private_key, gm.nonce
		  FROM group_members gm
		  JOIN users u ON u.id = gm.user_id
		 WHERE gm.group_id = ANY($1)
		 ORDER BY gm.group_id, u.display_name, u.id`

	rows, err := r.pool.Query(ctx, query, ids)
	if err != nil {
		return fmt.Errorf("select group members: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			groupID   int64
			member    access.GroupMember
			publicKey []byte
		)

		err := rows.Scan(&groupID, &member.UserID, &member.Login, &member.DisplayName,
			&publicKey, &member.KeyVersion, &member.WrappedKey, &member.Nonce)
		if err != nil {
			return fmt.Errorf("scan group member: %w", err)
		}

		member.Fingerprint = vault.Fingerprint(publicKey)
		index := at[groupID]
		groups[index].Members = append(groups[index].Members, member)
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate group members: %w", err)
	}

	return nil
}

// CreateGroup writes the group and its founding members together. A group whose private
// key reached nobody could never be opened, and nothing later could repair that.
func (r *AccessRepository) CreateGroup(
	ctx context.Context,
	in access.NewGroup,
	actorID int64,
) (*access.Group, error) {
	var groupID int64

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		const insert = `
			INSERT INTO groups (client_id, vault_id, meta, meta_nonce, public_key, key_version, created_by)
			VALUES ($1::UUID, $2, $3, $4, $5, $6, $7)
			RETURNING id`

		err := tx.QueryRow(ctx, insert, in.ClientID, in.VaultID, in.Meta.Ciphertext,
			in.Meta.Nonce, in.PublicKey, in.KeyVersion, actorID).Scan(&groupID)
		if err != nil {
			return fmt.Errorf("insert group: %w", err)
		}

		if err := insertGroupMembers(ctx, tx, groupID, in.KeyVersion, in.Members); err != nil {
			return err
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     in.VaultID,
			ActorID:     actorID,
			Action:      vault.AuditGroupCreated,
			SubjectType: string(vault.SubjectGroup),
			SubjectID:   groupID,
			Detail:      fmt.Sprintf(`{"members":%d}`, len(in.Members)),
		})
	})
	if err != nil {
		return nil, err
	}

	return r.Group(ctx, groupID)
}

func (r *AccessRepository) UpdateGroupMeta(ctx context.Context, groupID int64, meta vault.Blob) error {
	const query = `
		UPDATE groups SET meta = $2, meta_nonce = $3, updated_at = now() WHERE id = $1`

	tag, err := r.pool.Exec(ctx, query, groupID, meta.Ciphertext, meta.Nonce)
	if err != nil {
		return fmt.Errorf("update group: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return access.ErrNotFound
	}

	return nil
}

// DeleteGroup disbands a group. Its permission grants and its key grants go with it: a
// grant addressed to a group that no longer exists would be a permission nobody can audit.
func (r *AccessRepository) DeleteGroup(ctx context.Context, groupID, actorID int64) error {
	return inTx(ctx, r.pool, func(tx pgx.Tx) error {
		var vaultID int64

		const owner = `SELECT vault_id FROM groups WHERE id = $1`

		if err := tx.QueryRow(ctx, owner, groupID).Scan(&vaultID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return access.ErrNotFound
			}

			return fmt.Errorf("select group vault: %w", err)
		}

		const dropKeys = `
			DELETE FROM key_grants kg USING key_scopes ks
			 WHERE ks.id = kg.scope_id AND ks.vault_id = $1
			   AND kg.subject_type = 'group' AND kg.subject_id = $2`

		if _, err := tx.Exec(ctx, dropKeys, vaultID, groupID); err != nil {
			return fmt.Errorf("delete group key grants: %w", err)
		}

		const dropGrants = `
			DELETE FROM grants WHERE vault_id = $1 AND subject_type = 'group' AND subject_id = $2`

		if _, err := tx.Exec(ctx, dropGrants, vaultID, groupID); err != nil {
			return fmt.Errorf("delete group grants: %w", err)
		}

		if _, err := tx.Exec(ctx, `DELETE FROM groups WHERE id = $1`, groupID); err != nil {
			return fmt.Errorf("delete group: %w", err)
		}

		// Everybody's view of who can reach what just changed.
		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		if _, err := tx.Exec(ctx,
			`UPDATE vault_members SET access_seq = $2 WHERE vault_id = $1`, vaultID, seq); err != nil {
			return fmt.Errorf("bump access sequence: %w", err)
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditGroupGone,
			SubjectType: string(vault.SubjectGroup),
			SubjectID:   groupID,
		})
	})
}

// SetGroupMembers replaces the membership, and when the keypair changes swaps the public
// key and every scope key sealed to the group in the same transaction. A rotation applied
// in pieces would leave the group holding a key that opens nothing.
func (r *AccessRepository) SetGroupMembers(
	ctx context.Context,
	in access.GroupMembership,
	actorID int64,
) (*access.Group, error) {
	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		var (
			vaultID int64
			version int32
		)

		const current = `SELECT vault_id, key_version FROM groups WHERE id = $1`

		if err := tx.QueryRow(ctx, current, in.GroupID).Scan(&vaultID, &version); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return access.ErrNotFound
			}

			return fmt.Errorf("select group: %w", err)
		}

		if in.Rotates() {
			// A rotation replaces every key the group holds, so the caller has to bring one
			// for each. They cannot be trusted to know the full set: their own tree shows
			// only what they can see, and a manager explicitly denied one folder would
			// silently drop the group's key for it — leaving the group with a permission on
			// a folder nobody in it can open.
			if err := allScopesResealed(ctx, tx, in); err != nil {
				return err
			}

			const rotate = `
				UPDATE groups SET public_key = $2, key_version = $3, updated_at = now()
				 WHERE id = $1`

			if _, err := tx.Exec(ctx, rotate, in.GroupID, in.PublicKey, in.KeyVersion); err != nil {
				return fmt.Errorf("rotate group key: %w", err)
			}

			version = in.KeyVersion

			// The old scope keys were sealed to a keypair somebody who just left still
			// holds. Replacing them is the whole point of the rotation.
			const dropScopeKeys = `
				DELETE FROM key_grants kg USING key_scopes ks
				 WHERE ks.id = kg.scope_id AND ks.vault_id = $1
				   AND kg.subject_type = 'group' AND kg.subject_id = $2`

			if _, err := tx.Exec(ctx, dropScopeKeys, vaultID, in.GroupID); err != nil {
				return fmt.Errorf("delete group scope keys: %w", err)
			}

			subject := vault.Subject{Type: vault.SubjectGroup, ID: in.GroupID}
			if err := insertKeyGrants(ctx, tx, subject, in.Keys, actorID); err != nil {
				return err
			}
		}

		if _, err := tx.Exec(ctx, `DELETE FROM group_members WHERE group_id = $1`, in.GroupID); err != nil {
			return fmt.Errorf("clear group members: %w", err)
		}

		if err := insertGroupMembers(ctx, tx, in.GroupID, version, in.Members); err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		if _, err := tx.Exec(ctx,
			`UPDATE vault_members SET access_seq = $2 WHERE vault_id = $1`, vaultID, seq); err != nil {
			return fmt.Errorf("bump access sequence: %w", err)
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditGroupMembers,
			SubjectType: string(vault.SubjectGroup),
			SubjectID:   in.GroupID,
			Detail: fmt.Sprintf(`{"members":%d,"rotated":%t,"key_version":%d}`,
				len(in.Members), in.Rotates(), version),
		})
	})
	if err != nil {
		return nil, err
	}

	return r.Group(ctx, in.GroupID)
}

// GroupKeys hands back the caller's own copy of each group private key, at the version the
// group is on. Older copies stay in the table for grants written under them.
func (r *AccessRepository) GroupKeys(ctx context.Context, vaultID, userID int64) ([]access.GroupKey, error) {
	const query = `
		SELECT gm.group_id, g.client_id, gm.key_version, gm.wrapped_private_key, gm.nonce
		  FROM group_members gm
		  JOIN groups g ON g.id = gm.group_id
		 WHERE g.vault_id = $1 AND gm.user_id = $2
		 ORDER BY gm.group_id, gm.key_version`

	rows, err := r.pool.Query(ctx, query, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("select group keys: %w", err)
	}
	defer rows.Close()

	keys := make([]access.GroupKey, 0)

	for rows.Next() {
		var key access.GroupKey

		err := rows.Scan(&key.GroupID, &key.GroupClientID, &key.KeyVersion,
			&key.WrappedKey, &key.Nonce)
		if err != nil {
			return nil, fmt.Errorf("scan group key: %w", err)
		}

		keys = append(keys, key)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate group keys: %w", err)
	}

	return keys, nil
}

// GroupScopes lists every key the group holds, so a client can re-seal all of them.
func (r *AccessRepository) GroupScopes(ctx context.Context, groupID int64) ([]access.GroupScope, error) {
	const query = `
		SELECT kg.scope_id, ks.client_id, kg.key_version
		  FROM key_grants kg
		  JOIN key_scopes ks ON ks.id = kg.scope_id
		 WHERE kg.subject_type = 'group' AND kg.subject_id = $1
		 ORDER BY kg.scope_id, kg.key_version`

	rows, err := r.pool.Query(ctx, query, groupID)
	if err != nil {
		return nil, fmt.Errorf("select group scopes: %w", err)
	}
	defer rows.Close()

	scopes := make([]access.GroupScope, 0)

	for rows.Next() {
		var scope access.GroupScope

		if err := rows.Scan(&scope.ScopeID, &scope.ScopeClientID, &scope.KeyVersion); err != nil {
			return nil, fmt.Errorf("scan group scope: %w", err)
		}

		scopes = append(scopes, scope)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate group scopes: %w", err)
	}

	return scopes, nil
}

func insertGroupMembers(
	ctx context.Context,
	tx pgx.Tx,
	groupID int64,
	version int32,
	members []access.SealedGroupKey,
) error {
	const insert = `
		INSERT INTO group_members (group_id, user_id, key_version, wrapped_private_key, nonce)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (group_id, user_id) DO UPDATE
		    SET key_version = EXCLUDED.key_version,
		        wrapped_private_key = EXCLUDED.wrapped_private_key,
		        nonce = EXCLUDED.nonce`

	for _, member := range members {
		_, err := tx.Exec(ctx, insert, groupID, member.UserID, version,
			member.WrappedKey, member.Nonce)
		if err != nil {
			return fmt.Errorf("insert group member: %w", err)
		}
	}

	return nil
}

func scanGroup(row pgx.Row) (*access.Group, error) {
	var group access.Group

	err := row.Scan(&group.ID, &group.ClientID, &group.VaultID,
		&group.Meta.Ciphertext, &group.Meta.Nonce,
		&group.PublicKey, &group.KeyVersion, &group.CreatedBy, &group.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("scan group: %w", err)
	}

	return &group, nil
}

// scopeVersion is one key the group holds: a scope at a particular version.
type scopeVersion struct {
	scopeID int64
	version int32
}

// allScopesResealed refuses a rotation that would drop a key the group already holds.
//
// The comparison is per version, not per scope. A scope that has itself been re-keyed
// leaves the group holding both the old version and the new one on purpose — revisions and
// trashed rows are still sealed under the old — and the rotation deletes every version, so
// matching on the scope alone would let a payload carrying only the current one through and
// take the history with it.
func allScopesResealed(ctx context.Context, tx pgx.Tx, in access.GroupMembership) error {
	const held = `
		SELECT kg.scope_id, kg.key_version
		  FROM key_grants kg
		 WHERE kg.subject_type = 'group' AND kg.subject_id = $1`

	rows, err := tx.Query(ctx, held, in.GroupID)
	if err != nil {
		return fmt.Errorf("select group scopes: %w", err)
	}
	defer rows.Close()

	supplied := make(map[scopeVersion]bool, len(in.Keys))
	for _, key := range in.Keys {
		supplied[scopeVersion{scopeID: key.ScopeID, version: key.KeyVersion}] = true
	}

	for rows.Next() {
		var have scopeVersion

		if err := rows.Scan(&have.scopeID, &have.version); err != nil {
			return fmt.Errorf("scan group scope: %w", err)
		}

		if !supplied[have] {
			return access.ErrGroupScopes
		}
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate group scopes: %w", err)
	}

	return nil
}
