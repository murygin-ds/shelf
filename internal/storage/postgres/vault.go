package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const vaultColumns = `id, client_id, owner_id, meta, meta_nonce, change_seq, created_at, updated_at`

// VaultRepository implements the storage interfaces of the vault domain.
type VaultRepository struct {
	pool     *pgxpool.Pool
	announce Announcer
}

// NewVaultRepository builds the repository. A nil announcer means nothing is told about a
// change, which is what the tests and any non-serving caller want.
func NewVaultRepository(pool *pgxpool.Pool, announce Announcer) *VaultRepository {
	return &VaultRepository{pool: pool, announce: announce}
}

func (r *VaultRepository) inTx(ctx context.Context, fn func(*txn) error) error {
	return inTx(ctx, r.pool, r.announce, fn)
}

// CreateVault writes the vault, its key scope, the owner membership and the owner's key
// grant in one transaction. Splitting them would leave a window in which a key grant
// exists without the permission that justifies it.
func (r *VaultRepository) CreateVault(ctx context.Context, in vault.NewVault) (*vault.Vault, error) {
	var created *vault.Vault

	err := r.inTx(ctx, func(tx *txn) error {
		const insertVault = `
			INSERT INTO vaults (client_id, owner_id, meta, meta_nonce)
			VALUES ($1, $2, $3, $4)
			RETURNING ` + vaultColumns

		row := tx.QueryRow(ctx, insertVault, in.ClientID, in.OwnerID, in.Meta.Ciphertext, in.Meta.Nonce)

		opened, err := scanVault(row)
		if err != nil {
			return fmt.Errorf("insert vault: %w", err)
		}

		const insertScope = `
			INSERT INTO key_scopes (client_id, vault_id, scope_type, scope_ref_id, key_version)
			VALUES ($2, $1, 'vault', $1, 1)
			RETURNING id`

		var scopeID int64
		if err := tx.QueryRow(ctx, insertScope, opened.ID, in.ScopeClientID).Scan(&scopeID); err != nil {
			return fmt.Errorf("insert key scope: %w", err)
		}

		const insertMember = `
			INSERT INTO vault_members (vault_id, user_id, role, key_state)
			VALUES ($1, $2, 'owner', 'ok')`

		if _, err := tx.Exec(ctx, insertMember, opened.ID, in.OwnerID); err != nil {
			return fmt.Errorf("insert vault member: %w", err)
		}

		const insertGrant = `
			INSERT INTO key_grants (scope_id, key_version, subject_type, subject_id,
			                        wrapped_key, nonce, wrap_algorithm, granted_by)
			VALUES ($1, 1, 'user', $2, $3, $4, $5, $2)`

		_, err = tx.Exec(ctx, insertGrant,
			scopeID, in.OwnerID, in.Key.WrappedKey, in.Key.Nonce, in.Key.Algorithm)
		if err != nil {
			return fmt.Errorf("insert key grant: %w", err)
		}

		created = opened

		return nil
	})
	if err != nil {
		return nil, err
	}

	return created, nil
}

func (r *VaultRepository) Vault(ctx context.Context, vaultID int64) (*vault.Vault, error) {
	const query = `SELECT ` + vaultColumns + ` FROM vaults WHERE id = $1`

	found, err := scanVault(r.pool.QueryRow(ctx, query, vaultID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select vault: %w", err)
	}

	return found, nil
}

// VaultsByMember feeds the vault switcher. The note and member counts are vault-wide
// rather than filtered to what the caller can open: the design shows them that way, and
// the totals are already visible through the graph.
func (r *VaultRepository) VaultsByMember(ctx context.Context, userID int64) ([]vault.Summary, error) {
	const query = `
		SELECT v.id, v.client_id, v.owner_id, v.meta, v.meta_nonce, v.change_seq, v.created_at, v.updated_at,
		       m.role, m.key_state, ks.client_id, ks.id, ks.key_version,
		       (SELECT count(*) FROM files f WHERE f.vault_id = v.id AND f.deleted_at IS NULL),
		       (SELECT count(*) FROM vault_members vm WHERE vm.vault_id = v.id),
		       m.label, m.label_nonce
		  FROM vaults v
		  JOIN vault_members m ON m.vault_id = v.id AND m.user_id = $1
		  JOIN key_scopes ks ON ks.vault_id = v.id AND ks.scope_type = 'vault' AND ks.scope_ref_id = v.id
		 ORDER BY v.created_at, v.id`

	rows, err := r.pool.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("select vaults: %w", err)
	}
	defer rows.Close()

	summaries := make([]vault.Summary, 0)

	for rows.Next() {
		var (
			s          vault.Summary
			label      []byte
			labelNonce []byte
		)

		err := rows.Scan(
			&s.ID, &s.ClientID, &s.OwnerID, &s.Meta.Ciphertext, &s.Meta.Nonce, &s.ChangeSeq, &s.CreatedAt, &s.UpdatedAt,
			&s.Role, &s.KeyState, &s.KeyScopeClientID, &s.KeyScopeID, &s.KeyVersion, &s.NoteCount, &s.MemberCount,
			&label, &labelNonce,
		)
		if err != nil {
			return nil, fmt.Errorf("scan vault summary: %w", err)
		}

		if label != nil {
			s.Label = &vault.Blob{Ciphertext: label, Nonce: labelNonce}
		}

		summaries = append(summaries, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate vaults: %w", err)
	}

	return summaries, nil
}

func (r *VaultRepository) UpdateVaultMeta(ctx context.Context, vaultID int64, meta vault.Blob) error {
	const query = `UPDATE vaults SET meta = $2, meta_nonce = $3 WHERE id = $1`

	tag, err := r.pool.Exec(ctx, query, vaultID, meta.Ciphertext, meta.Nonce)
	if err != nil {
		return fmt.Errorf("update vault: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return vault.ErrNotFound
	}

	return nil
}

// SetMemberLabel writes one member's private note on a vault. A nil label clears it, and
// the pair goes together — half a sealed box cannot be opened.
func (r *VaultRepository) SetMemberLabel(
	ctx context.Context,
	vaultID, userID int64,
	label *vault.Blob,
) error {
	const query = `
		UPDATE vault_members SET label = $3, label_nonce = $4
		 WHERE vault_id = $1 AND user_id = $2`

	var ciphertext, nonce []byte
	if label != nil {
		ciphertext, nonce = label.Ciphertext, label.Nonce
	}

	tag, err := r.pool.Exec(ctx, query, vaultID, userID, ciphertext, nonce)
	if err != nil {
		return fmt.Errorf("set member label: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return vault.ErrNotFound
	}

	return nil
}

func (r *VaultRepository) DeleteVault(ctx context.Context, vaultID int64) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM vaults WHERE id = $1`, vaultID)
	if err != nil {
		return fmt.Errorf("delete vault: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return vault.ErrNotFound
	}

	return nil
}

func (r *VaultRepository) Membership(ctx context.Context, vaultID, userID int64) (*vault.Membership, error) {
	const query = `
		SELECT vault_id, user_id, role, key_state, access_seq
		  FROM vault_members WHERE vault_id = $1 AND user_id = $2`

	var member vault.Membership

	err := r.pool.QueryRow(ctx, query, vaultID, userID).Scan(
		&member.VaultID, &member.UserID, &member.Role, &member.KeyState, &member.AccessSeq,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Indistinguishable from a vault that does not exist, on purpose.
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select membership: %w", err)
	}

	return &member, nil
}

// KeyGrants returns every grant the caller can open in this vault, at every version:
// revisions and trashed items stay encrypted under the version that was current when they
// were written, so dropping the old versions would break the history tab.
func (r *VaultRepository) KeyGrants(ctx context.Context, vaultID, userID int64) ([]vault.KeyGrant, error) {
	const query = `
		SELECT kg.id, kg.scope_id, ks.client_id, kg.key_version, kg.subject_type, kg.subject_id,
		       kg.wrapped_key, kg.nonce, kg.wrap_algorithm
		  FROM key_grants kg
		  JOIN key_scopes ks ON ks.id = kg.scope_id
		 WHERE ks.vault_id = $1
		   AND ((kg.subject_type = 'user' AND kg.subject_id = $2)
		     OR (kg.subject_type = 'group'
		         AND kg.subject_id IN (SELECT group_id FROM group_members WHERE user_id = $2)))
		 ORDER BY kg.scope_id, kg.key_version`

	rows, err := r.pool.Query(ctx, query, vaultID, userID)
	if err != nil {
		return nil, fmt.Errorf("select key grants: %w", err)
	}
	defer rows.Close()

	grants := make([]vault.KeyGrant, 0)

	for rows.Next() {
		var g vault.KeyGrant

		err := rows.Scan(
			&g.ID, &g.ScopeID, &g.ScopeClientID, &g.KeyVersion, &g.Subject.Type, &g.Subject.ID,
			&g.WrappedKey, &g.Nonce, &g.Algorithm,
		)
		if err != nil {
			return nil, fmt.Errorf("scan key grant: %w", err)
		}

		grants = append(grants, g)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate key grants: %w", err)
	}

	return grants, nil
}

func (r *VaultRepository) Scopes(ctx context.Context, vaultID int64) ([]vault.ScopeStatus, error) {
	const query = `
		SELECT ks.id, ks.client_id, ks.vault_id, ks.scope_type, ks.scope_ref_id, ks.key_version, ks.updated_at,
		       (SELECT count(*) FROM key_grants kg
		         WHERE kg.scope_id = ks.id AND kg.key_version = ks.key_version)
		  FROM key_scopes ks
		 WHERE ks.vault_id = $1
		 ORDER BY ks.id`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select key scopes: %w", err)
	}
	defer rows.Close()

	scopes := make([]vault.ScopeStatus, 0)

	for rows.Next() {
		var s vault.ScopeStatus

		err := rows.Scan(&s.ID, &s.ClientID, &s.VaultID, &s.Type, &s.RefID,
			&s.KeyVersion, &s.RotatedAt, &s.GrantCount)
		if err != nil {
			return nil, fmt.Errorf("scan key scope: %w", err)
		}

		scopes = append(scopes, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate key scopes: %w", err)
	}

	return scopes, nil
}

func scanVault(row pgx.Row) (*vault.Vault, error) {
	var v vault.Vault

	err := row.Scan(&v.ID, &v.ClientID, &v.OwnerID, &v.Meta.Ciphertext, &v.Meta.Nonce,
		&v.ChangeSeq, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return nil, err
	}

	return &v, nil
}
