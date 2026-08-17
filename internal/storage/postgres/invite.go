package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/access"
	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

const inviteColumns = `i.id, i.vault_id, i.role, COALESCE(i.email_hint, ''), i.target_user_id,
	i.invited_by, COALESCE(u.display_name, ''), i.expires_at, i.redeemed_at, i.revoked_at, i.created_at`

// CreateInvite writes the invite and the scope keys addressed to it in one transaction.
// The keys are sealed to the invite rather than to a person: for a code invite nobody
// knows yet who will use it, and the code is the only thing that opens them.
func (r *AccessRepository) CreateInvite(ctx context.Context, in access.NewInvite) (*access.Invite, error) {
	var created *access.Invite

	err := r.inTx(ctx, func(tx *txn) error {
		const insert = `
			INSERT INTO invites (vault_id, token_hash, target_user_id, email_hint, role,
			                     wrapped_preview, preview_nonce, invited_by, expires_at)
			VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8, $9)
			RETURNING id`

		var inviteID int64

		err := tx.QueryRow(ctx, insert,
			in.VaultID, in.TokenHash, in.TargetUser, in.EmailHint, in.Role,
			in.Preview.Ciphertext, in.Preview.Nonce, in.InvitedBy, in.ExpiresAt,
		).Scan(&inviteID)
		if err != nil {
			if isUniqueViolation(err) {
				return access.ErrInviteInvalid
			}

			return fmt.Errorf("insert invite: %w", err)
		}

		subject := vault.Subject{Type: vault.SubjectInvite, ID: inviteID}
		if err := insertKeyGrants(ctx, tx, subject, in.Keys, in.InvitedBy); err != nil {
			return err
		}

		if created, err = scanInviteTx(ctx, tx, inviteID); err != nil {
			return err
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     in.VaultID,
			ActorID:     in.InvitedBy,
			Action:      vault.AuditInviteMade,
			SubjectType: string(vault.SubjectInvite),
			SubjectID:   inviteID,
			Detail:      fmt.Sprintf(`{"role":%q,"by_code":%t}`, in.Role, in.TargetUser == nil),
		})
	})
	if err != nil {
		return nil, err
	}

	return created, nil
}

func (r *AccessRepository) Invites(ctx context.Context, vaultID int64) ([]access.Invite, error) {
	const query = `
		SELECT ` + inviteColumns + `
		  FROM invites i
		  LEFT JOIN users u ON u.id = i.invited_by
		 WHERE i.vault_id = $1 AND i.redeemed_at IS NULL AND i.revoked_at IS NULL
		 ORDER BY i.created_at DESC, i.id`

	return r.queryInvites(ctx, query, vaultID)
}

func (r *AccessRepository) InvitesFor(ctx context.Context, userID int64) ([]access.Invite, error) {
	const query = `
		SELECT ` + inviteColumns + `
		  FROM invites i
		  LEFT JOIN users u ON u.id = i.invited_by
		 WHERE i.target_user_id = $1
		   AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
		 ORDER BY i.created_at DESC, i.id`

	return r.queryInvites(ctx, query, userID)
}

func (r *AccessRepository) queryInvites(ctx context.Context, query string, arg int64) ([]access.Invite, error) {
	rows, err := r.pool.Query(ctx, query, arg)
	if err != nil {
		return nil, fmt.Errorf("select invites: %w", err)
	}
	defer rows.Close()

	invites := make([]access.Invite, 0)

	for rows.Next() {
		invite, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}

		invites = append(invites, *invite)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate invites: %w", err)
	}

	return invites, nil
}

func (r *AccessRepository) RevokeInvite(ctx context.Context, vaultID, inviteID, actorID int64) error {
	return r.inTx(ctx, func(tx *txn) error {
		const query = `
			UPDATE invites SET revoked_at = now()
			 WHERE id = $1 AND vault_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`

		tag, err := tx.Exec(ctx, query, inviteID, vaultID)
		if err != nil {
			return fmt.Errorf("revoke invite: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return access.ErrNotFound
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     actorID,
			Action:      vault.AuditInviteGone,
			SubjectType: string(vault.SubjectInvite),
			SubjectID:   inviteID,
		})
	})
}

// ChallengeByToken resolves a code invite for an anonymous caller. Every reason it might
// fail — wrong code, expired, already used, revoked — is one condition here, so the answer
// cannot be used to tell valid codes from invalid ones.
func (r *AccessRepository) ChallengeByToken(ctx context.Context, tokenHash []byte) (*access.Challenge, error) {
	const query = `
		SELECT id, wrapped_preview, preview_nonce, expires_at
		  FROM invites
		 WHERE token_hash = $1 AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`

	return r.challenge(ctx, query, tokenHash)
}

func (r *AccessRepository) ChallengeForUser(ctx context.Context, inviteID, userID int64) (*access.Challenge, error) {
	const query = `
		SELECT id, wrapped_preview, preview_nonce, expires_at
		  FROM invites
		 WHERE id = $1 AND target_user_id = $2
		   AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()`

	return r.challenge(ctx, query, inviteID, userID)
}

func (r *AccessRepository) challenge(ctx context.Context, query string, args ...any) (*access.Challenge, error) {
	var found access.Challenge

	err := r.pool.QueryRow(ctx, query, args...).Scan(
		&found.InviteID, &found.Preview.Ciphertext, &found.Preview.Nonce, &found.ExpiresAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, access.ErrInviteInvalid
		}

		return nil, fmt.Errorf("select invite: %w", err)
	}

	keys, err := r.inviteKeys(ctx, found.InviteID)
	if err != nil {
		return nil, err
	}

	found.Keys = keys

	return &found, nil
}

func (r *AccessRepository) inviteKeys(ctx context.Context, inviteID int64) ([]access.SealedKey, error) {
	const query = `
		SELECT kg.scope_id, ks.client_id, kg.key_version, kg.wrapped_key, kg.nonce, kg.wrap_algorithm
		  FROM key_grants kg
		  JOIN key_scopes ks ON ks.id = kg.scope_id
		 WHERE kg.subject_type = 'invite' AND kg.subject_id = $1
		 ORDER BY kg.scope_id, kg.key_version`

	rows, err := r.pool.Query(ctx, query, inviteID)
	if err != nil {
		return nil, fmt.Errorf("select invite keys: %w", err)
	}
	defer rows.Close()

	keys := make([]access.SealedKey, 0)

	for rows.Next() {
		var key access.SealedKey

		err := rows.Scan(&key.ScopeID, &key.ScopeClientID, &key.KeyVersion,
			&key.WrappedKey, &key.Nonce, &key.Algorithm)
		if err != nil {
			return nil, fmt.Errorf("scan invite key: %w", err)
		}

		keys = append(keys, key)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate invite keys: %w", err)
	}

	return keys, nil
}

// Redeem admits the caller and closes the invite in the same transaction.
//
// The invite's own key grants are deleted as part of it: they were sealed to a secret that
// has now been used, and leaving them would keep a second way in for anyone who ever saw
// the code.
func (r *AccessRepository) Redeem(
	ctx context.Context,
	in access.Redemption,
	userID int64,
) (*access.Invite, error) {
	var redeemed *access.Invite

	err := r.inTx(ctx, func(tx *txn) error {
		const claim = `
			UPDATE invites SET redeemed_at = now(), redeemed_by = $3
			 WHERE (($1::BYTEA IS NOT NULL AND token_hash = $1)
			     OR ($1::BYTEA IS NULL AND id = $2 AND target_user_id = $3))
			   AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
			RETURNING id, vault_id, role`

		var (
			inviteID int64
			vaultID  int64
			role     vault.Role
		)

		err := tx.QueryRow(ctx, claim, in.TokenHash, in.InviteID, userID).Scan(&inviteID, &vaultID, &role)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return access.ErrInviteInvalid
			}

			return fmt.Errorf("claim invite: %w", err)
		}

		seq, err := nextSeq(ctx, tx, vaultID)
		if err != nil {
			return err
		}

		const admit = `
			INSERT INTO vault_members (vault_id, user_id, role, key_state, access_seq, invited_by)
			VALUES ($1, $2, $3, 'ok', $4, (SELECT invited_by FROM invites WHERE id = $5))
			ON CONFLICT (vault_id, user_id) DO NOTHING`

		tag, err := tx.Exec(ctx, admit, vaultID, userID, role, seq, inviteID)
		if err != nil {
			return fmt.Errorf("insert membership: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return access.ErrAlreadyMember
		}

		subject := vault.Subject{Type: vault.SubjectUser, ID: userID}
		if err := insertKeyGrants(ctx, tx, subject, in.Keys, userID); err != nil {
			return err
		}

		const dropInviteKeys = `DELETE FROM key_grants WHERE subject_type = 'invite' AND subject_id = $1`

		if _, err := tx.Exec(ctx, dropInviteKeys, inviteID); err != nil {
			return fmt.Errorf("delete invite keys: %w", err)
		}

		if redeemed, err = scanInviteTx(ctx, tx, inviteID); err != nil {
			return err
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:     vaultID,
			ActorID:     userID,
			Action:      vault.AuditMemberJoined,
			SubjectType: string(vault.SubjectUser),
			SubjectID:   userID,
			Detail:      fmt.Sprintf(`{"role":%q,"invite_id":%d}`, role, inviteID),
		})
	})
	if err != nil {
		return nil, err
	}

	return redeemed, nil
}

func scanInviteTx(ctx context.Context, tx pgx.Tx, inviteID int64) (*access.Invite, error) {
	const query = `
		SELECT ` + inviteColumns + `
		  FROM invites i
		  LEFT JOIN users u ON u.id = i.invited_by
		 WHERE i.id = $1`

	return scanInvite(tx.QueryRow(ctx, query, inviteID))
}

func scanInvite(row pgx.Row) (*access.Invite, error) {
	var invite access.Invite

	err := row.Scan(
		&invite.ID, &invite.VaultID, &invite.Role, &invite.EmailHint, &invite.TargetUser,
		&invite.InvitedBy, &invite.InviterName, &invite.ExpiresAt,
		&invite.RedeemedAt, &invite.RevokedAt, &invite.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("scan invite: %w", err)
	}

	return &invite, nil
}
