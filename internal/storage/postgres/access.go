package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"shelf/internal/access"
	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AccessRepository implements the storage of membership, grants and invites.
type AccessRepository struct {
	pool     *pgxpool.Pool
	announce Announcer
}

// NewAccessRepository builds the repository. A nil announcer means nothing is told about a
// change, which is what the tests and any non-serving caller want.
func NewAccessRepository(pool *pgxpool.Pool, announce Announcer) *AccessRepository {
	return &AccessRepository{pool: pool, announce: announce}
}

func (r *AccessRepository) inTx(ctx context.Context, fn func(*txn) error) error {
	return inTx(ctx, r.pool, r.announce, fn)
}

// Members reads the vault's member table, including how many top-level folders each one
// can reach and when they were last seen.
func (r *AccessRepository) Members(ctx context.Context, vaultID int64) ([]access.Member, error) {
	const query = `
		SELECT u.id, u.login, u.display_name, u.public_key,
		       m.role, m.key_state, m.invited_by, m.created_at,
		       (SELECT max(s.last_used_at) FROM sessions s
		         WHERE s.user_id = u.id AND s.revoked_at IS NULL),
		       (SELECT count(*) FROM grants g
		         WHERE g.vault_id = m.vault_id AND g.subject_type = 'user' AND g.subject_id = u.id
		           AND g.permission <> 'none')
		  FROM vault_members m
		  JOIN users u ON u.id = m.user_id
		 WHERE m.vault_id = $1
		 ORDER BY permission_rank(role_permission(m.role)) DESC, u.display_name, u.id`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select members: %w", err)
	}
	defer rows.Close()

	members := make([]access.Member, 0)

	for rows.Next() {
		var m access.Member

		err := rows.Scan(
			&m.UserID, &m.Login, &m.DisplayName, &m.PublicKey,
			&m.Role, &m.KeyState, &m.InvitedBy, &m.CreatedAt, &m.LastActive, &m.FolderCount,
		)
		if err != nil {
			return nil, fmt.Errorf("scan member: %w", err)
		}

		m.Fingerprint = vault.Fingerprint(m.PublicKey)
		members = append(members, m)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate members: %w", err)
	}

	return members, nil
}

func (r *AccessRepository) Membership(ctx context.Context, vaultID, userID int64) (*vault.Membership, error) {
	const query = `
		SELECT vault_id, user_id, role, key_state, access_seq
		  FROM vault_members WHERE vault_id = $1 AND user_id = $2`

	var member vault.Membership

	err := r.pool.QueryRow(ctx, query, vaultID, userID).Scan(
		&member.VaultID, &member.UserID, &member.Role, &member.KeyState, &member.AccessSeq,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, access.ErrNotFound
		}

		return nil, fmt.Errorf("select membership: %w", err)
	}

	return &member, nil
}

// SetRole changes the floor a member starts from. It also bumps access_seq, which is what
// tells that member's clients their cached view is no longer authoritative.
func (r *AccessRepository) SetRole(ctx context.Context, vaultID, userID int64, role vault.Role, actorID int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const query = `
			UPDATE vault_members SET role = $3, access_seq = $4
			 WHERE vault_id = $1 AND user_id = $2`

		tag, err := tx.Exec(ctx, query, vaultID, userID, role, seq)
		if err != nil {
			return fmt.Errorf("update role: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return access.ErrNotFound
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditMemberRole,
			SubjectType: string(vault.SubjectUser),
			SubjectID:   userID,
			Detail:      fmt.Sprintf(`{"role":%q}`, role),
		})
	})
}

// RemoveMember revokes everything at once: the membership, the permission grants and the
// key grants at every version. It returns the scopes the member could read, which now
// need rotating before the revocation is retroactive rather than merely forward-looking.
func (r *AccessRepository) RemoveMember(ctx context.Context, vaultID, userID, actorID int64) ([]int64, error) {
	var scopes []int64

	err := r.inTx(ctx, func(tx *txn) error {
		// Both paths to a scope count. A member who read a folder only through a group still
		// holds that group's private key, and reporting nothing to rotate would make the
		// removal look complete when it is not.
		const held = `
			SELECT DISTINCT kg.scope_id
			  FROM key_grants kg
			  JOIN key_scopes ks ON ks.id = kg.scope_id
			 WHERE ks.vault_id = $1
			   AND ((kg.subject_type = 'user' AND kg.subject_id = $2)
			     OR (kg.subject_type = 'group'
			         AND kg.subject_id IN (SELECT group_id FROM group_members WHERE user_id = $2)))`

		rows, err := tx.Query(ctx, held, vaultID, userID)
		if err != nil {
			return fmt.Errorf("select held scopes: %w", err)
		}

		for rows.Next() {
			var scopeID int64
			if err := rows.Scan(&scopeID); err != nil {
				rows.Close()
				return fmt.Errorf("scan held scope: %w", err)
			}

			scopes = append(scopes, scopeID)
		}

		rows.Close()

		if err := rows.Err(); err != nil {
			return fmt.Errorf("iterate held scopes: %w", err)
		}

		const dropKeys = `
			DELETE FROM key_grants kg
			 USING key_scopes ks
			 WHERE ks.id = kg.scope_id AND ks.vault_id = $1
			   AND kg.subject_type = 'user' AND kg.subject_id = $2`

		if _, err := tx.Exec(ctx, dropKeys, vaultID, userID); err != nil {
			return fmt.Errorf("delete key grants: %w", err)
		}

		// Their copy of every group key goes too. Leaving the row would keep handing them a
		// working group key on the next /group-keys read, membership or no membership.
		const dropGroups = `
			DELETE FROM group_members gm
			 USING groups g
			 WHERE g.id = gm.group_id AND g.vault_id = $1 AND gm.user_id = $2`

		if _, err := tx.Exec(ctx, dropGroups, vaultID, userID); err != nil {
			return fmt.Errorf("delete group memberships: %w", err)
		}

		const dropGrants = `
			DELETE FROM grants
			 WHERE vault_id = $1 AND subject_type = 'user' AND subject_id = $2`

		if _, err := tx.Exec(ctx, dropGrants, vaultID, userID); err != nil {
			return fmt.Errorf("delete grants: %w", err)
		}

		const dropInvites = `
			UPDATE invites SET revoked_at = now()
			 WHERE vault_id = $1 AND target_user_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`

		if _, err := tx.Exec(ctx, dropInvites, vaultID, userID); err != nil {
			return fmt.Errorf("revoke invites: %w", err)
		}

		const dropMember = `DELETE FROM vault_members WHERE vault_id = $1 AND user_id = $2`

		tag, err := tx.Exec(ctx, dropMember, vaultID, userID)
		if err != nil {
			return fmt.Errorf("delete membership: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return access.ErrNotFound
		}

		// The scopes the removed member held are now stale for everyone: until they are
		// rotated, the key that member already copied still opens them.
		if len(scopes) > 0 {
			const markPending = `
				UPDATE vault_members SET key_state = 'pending_rotation'
				 WHERE vault_id = $1 AND key_state = 'ok'`

			if _, err := tx.Exec(ctx, markPending, vaultID); err != nil {
				return fmt.Errorf("mark scopes pending rotation: %w", err)
			}
		}

		// Everyone's cached view of who can see what just changed.
		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		if _, err := tx.Exec(ctx, `UPDATE vault_members SET access_seq = $2 WHERE vault_id = $1`, vaultID, seq); err != nil {
			return fmt.Errorf("bump access sequence: %w", err)
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditMemberRemove,
			SubjectType: string(vault.SubjectUser),
			SubjectID:   userID,
			Detail:      fmt.Sprintf(`{"scopes_pending_rotation":%d}`, len(scopes)),
		})
	})
	if err != nil {
		return nil, err
	}

	return scopes, nil
}

func (r *AccessRepository) Lookup(ctx context.Context, login string) (*access.Directory, error) {
	const query = `
		SELECT id, login, display_name, public_key
		  FROM users WHERE lower(login) = lower($1)`

	var found access.Directory

	err := r.pool.QueryRow(ctx, query, strings.TrimSpace(login)).Scan(
		&found.UserID, &found.Login, &found.DisplayName, &found.PublicKey,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, access.ErrNotFound
		}

		return nil, fmt.Errorf("select account: %w", err)
	}

	found.Fingerprint = vault.Fingerprint(found.PublicKey)

	return &found, nil
}

func (r *AccessRepository) PublicKey(ctx context.Context, userID int64) ([]byte, error) {
	var key []byte

	err := r.pool.QueryRow(ctx, `SELECT public_key FROM users WHERE id = $1`, userID).Scan(&key)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, access.ErrNotFound
		}

		return nil, fmt.Errorf("select public key: %w", err)
	}

	return key, nil
}

func (r *AccessRepository) Grants(
	ctx context.Context,
	vaultID int64,
	scopeType vault.ScopeType,
	scopeRefID int64,
) ([]access.Grant, error) {
	const query = `
		SELECT g.id, g.vault_id, g.scope_type, g.scope_ref_id, g.subject_type, g.subject_id,
		       g.permission, g.created_by, g.created_at,
		       COALESCE(u.display_name, u.login, '')
		  FROM grants g
		  LEFT JOIN users u ON g.subject_type = 'user' AND u.id = g.subject_id
		 WHERE g.vault_id = $1 AND g.scope_type = $2 AND g.scope_ref_id = $3
		 ORDER BY permission_rank(g.permission) DESC, g.id`

	rows, err := r.pool.Query(ctx, query, vaultID, scopeType, scopeRefID)
	if err != nil {
		return nil, fmt.Errorf("select grants: %w", err)
	}
	defer rows.Close()

	grants := make([]access.Grant, 0)

	for rows.Next() {
		var g access.Grant

		err := rows.Scan(
			&g.ID, &g.VaultID, &g.ScopeType, &g.ScopeRefID, &g.Subject.Type, &g.Subject.ID,
			&g.Permission, &g.CreatedBy, &g.CreatedAt, &g.SubjectLabel,
		)
		if err != nil {
			return nil, fmt.Errorf("scan grant: %w", err)
		}

		grants = append(grants, g)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate grants: %w", err)
	}

	return grants, nil
}

// PutGrant writes the permission and the sealed keys together. Separating them would leave
// a window in which a key exists without the permission that justifies it — which is the
// one thing this whole model exists to prevent.
func (r *AccessRepository) PutGrant(
	ctx context.Context,
	in access.GrantInput,
	actorID int64,
) (*access.Grant, error) {
	var granted *access.Grant

	err := r.inTx(ctx, func(tx *txn) error {
		const upsert = `
			INSERT INTO grants (vault_id, scope_type, scope_ref_id, subject_type, subject_id,
			                    permission, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (scope_type, scope_ref_id, subject_type, subject_id)
			DO UPDATE SET permission = EXCLUDED.permission
			RETURNING id, vault_id, scope_type, scope_ref_id, subject_type, subject_id,
			          permission, created_by, created_at`

		var g access.Grant

		err := tx.QueryRow(ctx, upsert,
			in.VaultID, in.ScopeType, in.ScopeRefID, in.Subject.Type, in.Subject.ID,
			in.Permission, actorID,
		).Scan(
			&g.ID, &g.VaultID, &g.ScopeType, &g.ScopeRefID, &g.Subject.Type, &g.Subject.ID,
			&g.Permission, &g.CreatedBy, &g.CreatedAt,
		)
		if err != nil {
			return fmt.Errorf("upsert grant: %w", err)
		}

		if err := insertKeyGrants(ctx, tx, in.Subject, in.Keys, actorID); err != nil {
			return err
		}

		if err := bumpAccess(ctx, tx, in.VaultID, in.Subject); err != nil {
			return err
		}

		granted = &g

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     in.VaultID,
			ActorID:     actorID,
			Action:      vault.AuditGrantSet,
			TargetType:  string(in.ScopeType),
			TargetID:    in.ScopeRefID,
			SubjectType: string(in.Subject.Type),
			SubjectID:   in.Subject.ID,
			Detail:      fmt.Sprintf(`{"permission":%q,"keys":%d}`, in.Permission, len(in.Keys)),
		})
	})
	if err != nil {
		return nil, err
	}

	return granted, nil
}

func (r *AccessRepository) DeleteGrant(ctx context.Context, vaultID, grantID, actorID int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		const query = `
			DELETE FROM grants WHERE id = $1 AND vault_id = $2
			RETURNING subject_type, subject_id`

		var subject vault.Subject

		err := tx.QueryRow(ctx, query, grantID, vaultID).Scan(&subject.Type, &subject.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return access.ErrNotFound
			}

			return fmt.Errorf("delete grant: %w", err)
		}

		if err := bumpAccess(ctx, tx, vaultID, subject); err != nil {
			return err
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditGrantCleared,
			SubjectType: string(subject.Type),
			SubjectID:   subject.ID,
		})
	})
}

// insertKeyGrants is the only place outside a rotation commit and an invite redemption
// where key grants are written, and it is always reached from inside a permission write.
func insertKeyGrants(
	ctx context.Context,
	tx pgx.Tx,
	subject vault.Subject,
	keys []access.SealedKey,
	actorID int64,
) error {
	const insert = `
		INSERT INTO key_grants (scope_id, key_version, subject_type, subject_id,
		                        wrapped_key, nonce, wrap_algorithm, granted_by)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'ecdh-p256-hkdf-a256gcm'), $8)
		ON CONFLICT (scope_id, key_version, subject_type, subject_id) DO NOTHING`

	for _, key := range keys {
		_, err := tx.Exec(ctx, insert,
			key.ScopeID, key.KeyVersion, subject.Type, subject.ID,
			key.WrappedKey, key.Nonce, key.Algorithm, actorID,
		)
		if err != nil {
			return fmt.Errorf("insert key grant: %w", err)
		}
	}

	return nil
}

// bumpAccess marks the affected members' cached view as stale. A group grant touches
// everyone in the group, which is exactly who needs to hear about it.
func bumpAccess(ctx context.Context, tx *txn, vaultID int64, subject vault.Subject) error {
	seq, err := nextSeq(ctx, tx, vaultID)
	if err != nil {
		return err
	}

	const forUser = `UPDATE vault_members SET access_seq = $3 WHERE vault_id = $1 AND user_id = $2`

	const forGroup = `
		UPDATE vault_members SET access_seq = $3
		 WHERE vault_id = $1
		   AND user_id IN (SELECT user_id FROM group_members WHERE group_id = $2)`

	query := forUser
	if subject.Type == vault.SubjectGroup {
		query = forGroup
	}

	if _, err := tx.Exec(ctx, query, vaultID, subject.ID, seq); err != nil {
		return fmt.Errorf("bump access sequence: %w", err)
	}

	return nil
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError

	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation
}
