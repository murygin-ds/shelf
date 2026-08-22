package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"shelf/internal/mcp"

	"github.com/jackc/pgx/v5"
)

const clientColumns = `id, client_id, client_name, redirect_uris, created_at`

// RegisterClient records a dynamic registration.
func (r *MCPRepository) RegisterClient(ctx context.Context, in mcp.NewClient) (*mcp.Client, error) {
	const insert = `
		INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
		VALUES ($1, $2, $3)
		RETURNING ` + clientColumns

	return scanClient(r.pool.QueryRow(ctx, insert, in.ClientID, in.Name, in.RedirectURIs))
}

// ClientByID resolves a registration, and marks it as still in use so an unused one can be
// swept later: dynamic registration writes a row on every fresh connection, and nothing
// else would ever remove them.
func (r *MCPRepository) ClientByID(ctx context.Context, clientID string) (*mcp.Client, error) {
	const query = `
		UPDATE oauth_clients SET last_used_at = now()
		 WHERE client_id = $1
		RETURNING ` + clientColumns

	return scanClient(r.pool.QueryRow(ctx, query, clientID))
}

// IssueCode records an authorization code as a digest.
func (r *MCPRepository) IssueCode(ctx context.Context, in mcp.NewCode) error {
	const insert = `
		INSERT INTO oauth_codes (code_hash, client_id, vault_id, user_id, redirect_uri,
		                         code_challenge, scope, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

	_, err := r.pool.Exec(ctx, insert, in.Hash, in.ClientID, in.VaultID, in.UserID,
		in.RedirectURI, in.CodeChallenge, in.Scope, in.ExpiresAt)
	if err != nil {
		return fmt.Errorf("insert authorization code: %w", err)
	}

	return nil
}

// SpendCode consumes a code exactly once.
//
// The row is marked rather than deleted: a code presented twice means the first presentation
// leaked, and the tokens it produced have to go with it. Deleting would leave the second
// attempt indistinguishable from a code that never existed.
func (r *MCPRepository) SpendCode(ctx context.Context, hash []byte) (*mcp.Code, error) {
	var (
		code     *mcp.Code
		replayed bool
	)

	err := inTx(ctx, r.pool, nil, func(tx *txn) error {
		const find = `
			SELECT client_id, vault_id, user_id, redirect_uri, code_challenge, scope,
			       consumed_at, expires_at > now()
			  FROM oauth_codes
			 WHERE code_hash = $1
			   FOR UPDATE`

		var (
			found      mcp.Code
			consumedAt *time.Time
			live       bool
		)

		err := tx.QueryRow(ctx, find, hash).Scan(
			&found.ClientID, &found.VaultID, &found.UserID, &found.RedirectURI,
			&found.CodeChallenge, &found.Scope, &consumedAt, &live)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return mcp.ErrInvalidGrant
			}

			return fmt.Errorf("select authorization code: %w", err)
		}

		if consumedAt != nil {
			const burn = `
				UPDATE mcp_tokens SET revoked_at = now()
				 WHERE vault_id = $1 AND client_id = $2 AND revoked_at IS NULL`

			if _, err := tx.Exec(ctx, burn, found.VaultID, found.ClientID); err != nil {
				return fmt.Errorf("revoke tokens from a replayed code: %w", err)
			}

			// Reported after the commit: returning from inside the transaction would roll
			// back the revocation this branch exists to perform.
			replayed = true

			return nil
		}

		if !live {
			return mcp.ErrInvalidGrant
		}

		if _, err := tx.Exec(ctx, `UPDATE oauth_codes SET consumed_at = now() WHERE code_hash = $1`, hash); err != nil {
			return fmt.Errorf("consume authorization code: %w", err)
		}

		code = &found

		return nil
	})
	if err != nil {
		return nil, err
	}

	if replayed {
		return nil, mcp.ErrInvalidGrant
	}

	return code, nil
}

func scanClient(row pgx.Row) (*mcp.Client, error) {
	var client mcp.Client

	err := row.Scan(&client.ID, &client.ClientID, &client.Name, &client.RedirectURIs, &client.CreatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, mcp.ErrInvalidClient
		}

		return nil, fmt.Errorf("scan oauth client: %w", err)
	}

	return &client, nil
}
