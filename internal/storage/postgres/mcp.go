package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/mcp"
	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MCPRepository stores the connectors: the accounts this server holds keys for.
type MCPRepository struct {
	pool     *pgxpool.Pool
	announce Announcer
}

// NewMCPRepository creates the repository.
func NewMCPRepository(pool *pgxpool.Pool, announce Announcer) *MCPRepository {
	return &MCPRepository{pool: pool, announce: announce}
}

const selectConnector = `
	SELECT c.vault_id, u.id, u.login, u.public_key, m.role, m.key_state, c.identity_fpr, c.created_at
	  FROM vault_mcp c
	  JOIN users u ON u.id = c.connector_user_id
	  JOIN vault_members m ON m.vault_id = c.vault_id AND m.user_id = c.connector_user_id
	 WHERE c.vault_id = $1`

// Create writes the account, the membership and the connector row in one transaction.
//
// The membership lands in pending_key on purpose: the browser cannot seal a scope key to a
// public key that does not exist yet, so between this and Admit there is a member with no
// key. That is a state the schema already models, and it reads nothing.
func (r *MCPRepository) Create(ctx context.Context, in mcp.NewConnector) (*mcp.Connector, error) {
	var connector *mcp.Connector

	err := inTx(ctx, r.pool, r.announce, func(tx *txn) error {
		// Idempotent by design: the browser may have to ask for the public key more than
		// once before it manages to seal to it, and a second account would orphan the first.
		existing, err := scanConnector(tx.QueryRow(ctx, selectConnector, in.VaultID))

		switch {
		case err == nil:
			connector = existing

			return nil
		// scanConnector already reports a missing row as ErrNotFound; anything else is a
		// real failure and must not be mistaken for "there is none yet".
		case !errors.Is(err, mcp.ErrNotFound):
			return err
		}

		const insertAccount = `
			INSERT INTO users (login, display_name, auth_hash, kdf_salt, kdf_params, wrapped_master_key,
			                   master_key_nonce, public_key, wrapped_private_key, private_key_nonce)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING id`

		account := in.Account

		var userID int64

		err = tx.QueryRow(ctx, insertAccount,
			account.Login, account.DisplayName, account.AuthHash, account.KDFSalt, account.KDFParams,
			account.WrappedMasterKey, account.MasterKeyNonce, account.PublicKey,
			account.WrappedPrivateKey, account.PrivateKeyNonce,
		).Scan(&userID)
		if err != nil {
			return fmt.Errorf("insert connector account: %w", err)
		}

		const insertMember = `
			INSERT INTO vault_members (vault_id, user_id, role, key_state, invited_by)
			VALUES ($1, $2, $3, 'pending_key', $4)`

		if _, err := tx.Exec(ctx, insertMember, in.VaultID, userID, in.Role, in.EnabledBy); err != nil {
			return fmt.Errorf("admit connector to the vault: %w", err)
		}

		const insertConnector = `
			INSERT INTO vault_mcp (vault_id, connector_user_id, identity_fpr, enabled_by)
			VALUES ($1, $2, $3, $4)`

		_, err = tx.Exec(ctx, insertConnector, in.VaultID, userID, account.Fingerprint, in.EnabledBy)
		if err != nil {
			if isUniqueViolation(err) {
				return mcp.ErrExists
			}

			return fmt.Errorf("insert connector: %w", err)
		}

		if err := recordAudit(ctx, tx, auditEntry{
			VaultID:     in.VaultID,
			ActorID:     in.EnabledBy,
			Action:      vault.AuditMCPEnabled,
			SubjectType: string(vault.SubjectUser),
			SubjectID:   userID,
		}); err != nil {
			return err
		}

		connector, err = scanConnector(tx.QueryRow(ctx, selectConnector, in.VaultID))

		return err
	})
	if err != nil {
		return nil, err
	}

	return connector, nil
}

// Admit hands the connector the scope keys the browser sealed to it.
//
// This is the sixth place a key grant is written, and like the other five it is the
// transaction that justifies the grant rather than an endpoint for writing one: the same
// statement that records the key is the one that marks the member able to read.
func (r *MCPRepository) Admit(ctx context.Context, vaultID, actorID int64, keys []mcp.SealedKey) (*mcp.Connector, error) {
	if len(keys) == 0 {
		return nil, fmt.Errorf("a connector admitted with no keys would read nothing")
	}

	var connector *mcp.Connector

	err := inTx(ctx, r.pool, r.announce, func(tx *txn) error {
		existing, err := scanConnector(tx.QueryRow(ctx, selectConnector, vaultID))
		if err != nil {
			return err
		}

		const insertGrant = `
			INSERT INTO key_grants (scope_id, key_version, subject_type, subject_id,
			                        wrapped_key, nonce, wrap_algorithm, granted_by)
			SELECT $1, $2, 'user', $3, $4, $5, COALESCE(NULLIF($6, ''), 'ecdh-p256-hkdf-a256gcm'), $7
			 WHERE EXISTS (SELECT 1 FROM key_scopes WHERE id = $1 AND vault_id = $8)
			ON CONFLICT (scope_id, key_version, subject_type, subject_id) DO NOTHING`

		for _, key := range keys {
			// The scope has to belong to this vault. Without the guard a caller could seal a
			// key to the connector against a scope in a vault they merely happen to hold.
			tag, err := tx.Exec(ctx, insertGrant,
				key.ScopeID, key.KeyVersion, existing.UserID, key.WrappedKey, key.Nonce,
				key.Algorithm, actorID, vaultID,
			)
			if err != nil {
				return fmt.Errorf("insert connector key grant: %w", err)
			}

			if tag.RowsAffected() == 0 {
				return vault.ErrScopeMismatch
			}
		}

		const ready = `
			UPDATE vault_members SET key_state = 'ok'
			 WHERE vault_id = $1 AND user_id = $2 AND key_state = 'pending_key'`

		if _, err := tx.Exec(ctx, ready, vaultID, existing.UserID); err != nil {
			return fmt.Errorf("mark the connector ready: %w", err)
		}

		if err := bumpAccess(ctx, tx, vaultID, vault.Subject{Type: vault.SubjectUser, ID: existing.UserID}); err != nil {
			return err
		}

		connector, err = scanConnector(tx.QueryRow(ctx, selectConnector, vaultID))

		return err
	})
	if err != nil {
		return nil, err
	}

	return connector, nil
}

// Connector reads the row for a vault.
func (r *MCPRepository) Connector(ctx context.Context, vaultID int64) (*mcp.Connector, error) {
	return scanConnector(r.pool.QueryRow(ctx, selectConnector, vaultID))
}

// Keys reads the wrapped halves of the connector's identity. It is the only query in this
// package whose result the server can turn into plaintext, and it is read per request rather
// than held, so that removing a connector takes effect at once.
func (r *MCPRepository) Keys(ctx context.Context, vaultID int64) (mcp.StoredKeys, error) {
	const query = `
		SELECT u.kdf_salt, u.public_key, u.wrapped_master_key, u.master_key_nonce,
		       u.wrapped_private_key, u.private_key_nonce
		  FROM vault_mcp c
		  JOIN users u ON u.id = c.connector_user_id
		 WHERE c.vault_id = $1`

	var keys mcp.StoredKeys

	err := r.pool.QueryRow(ctx, query, vaultID).Scan(
		&keys.KDFSalt, &keys.PublicKey, &keys.WrappedMasterKey, &keys.MasterKeyNonce,
		&keys.WrappedPrivateKey, &keys.PrivateKeyNonce,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return mcp.StoredKeys{}, mcp.ErrNotFound
		}

		return mcp.StoredKeys{}, fmt.Errorf("select connector keys: %w", err)
	}

	return keys, nil
}

// Grants are the scope keys sealed to the connector, at every version it still holds. Old
// versions are kept for the same reason they are kept for a person: the trash and the
// revision history are sealed under them.
func (r *MCPRepository) Grants(ctx context.Context, vaultID int64) ([]vault.KeyGrant, error) {
	const query = `
		SELECT kg.id, kg.scope_id, ks.client_id::TEXT, kg.key_version,
		       kg.wrapped_key, kg.nonce, kg.wrap_algorithm
		  FROM vault_mcp c
		  JOIN key_grants kg ON kg.subject_type = 'user' AND kg.subject_id = c.connector_user_id
		  JOIN key_scopes ks ON ks.id = kg.scope_id AND ks.vault_id = c.vault_id
		 WHERE c.vault_id = $1
		 ORDER BY kg.scope_id, kg.key_version`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select connector grants: %w", err)
	}
	defer rows.Close()

	grants := make([]vault.KeyGrant, 0)

	for rows.Next() {
		grant := vault.KeyGrant{Subject: vault.Subject{Type: vault.SubjectUser}}

		err := rows.Scan(&grant.ID, &grant.ScopeID, &grant.ScopeClientID, &grant.KeyVersion,
			&grant.WrappedKey, &grant.Nonce, &grant.Algorithm)
		if err != nil {
			return nil, fmt.Errorf("scan connector grant: %w", err)
		}

		grants = append(grants, grant)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate connector grants: %w", err)
	}

	return grants, nil
}

func scanConnector(row pgx.Row) (*mcp.Connector, error) {
	var c mcp.Connector

	err := row.Scan(&c.VaultID, &c.UserID, &c.Login, &c.PublicKey,
		&c.Role, &c.KeyState, &c.Fingerprint, &c.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, mcp.ErrNotFound
		}

		return nil, fmt.Errorf("scan connector: %w", err)
	}

	return &c, nil
}
