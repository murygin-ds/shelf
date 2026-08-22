package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"shelf/internal/mcp"

	"github.com/jackc/pgx/v5"
)

const tokenColumns = `id, vault_id, user_id, client_id, kind, label, chain_id, expires_at`

// IssueToken writes a credential. A refresh token with no chain starts one of its own, so a
// replay can always be traced to something to revoke.
func (r *MCPRepository) IssueToken(ctx context.Context, in mcp.NewToken) (*mcp.Token, error) {
	const insert = `
		INSERT INTO mcp_tokens (vault_id, user_id, client_id, kind, token_hash, label, chain_id, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING ` + tokenColumns

	row := r.pool.QueryRow(ctx, insert,
		in.VaultID, in.UserID, in.ClientID, in.Kind, in.Hash, in.Label, in.ChainID, in.ExpiresAt)

	token, err := scanToken(row)
	if err != nil {
		return nil, err
	}

	if in.Kind == mcp.KindRefresh && token.ChainID == nil {
		const startChain = `UPDATE mcp_tokens SET chain_id = id WHERE id = $1 RETURNING ` + tokenColumns

		return scanToken(r.pool.QueryRow(ctx, startChain, token.ID))
	}

	return token, nil
}

// TokenByHash resolves a credential that is live: not revoked, not expired, and of the kind
// the caller expected. Anything else simply does not exist.
func (r *MCPRepository) TokenByHash(ctx context.Context, hash []byte, kind string) (*mcp.Token, error) {
	// The read doubles as the touch. A separate update would be a second round trip on the
	// hot path for a column nothing depends on.
	const query = `
		UPDATE mcp_tokens SET last_used_at = now()
		 WHERE token_hash = $1 AND kind = $2 AND revoked_at IS NULL AND expires_at > now()
		RETURNING ` + tokenColumns

	return scanToken(r.pool.QueryRow(ctx, query, hash, kind))
}

// SpendRefresh consumes a refresh token once.
//
// A token presented twice means the first presentation leaked, and the chain it belongs to
// is burned rather than merely refused: the cost is one connector reconnecting, and the
// alternative is an attacker holding a valid chain for a month. It stops at the connector,
// which is the reason these do not live in the sessions table — there a replay logs the
// person out of their own browser.
func (r *MCPRepository) SpendRefresh(ctx context.Context, hash []byte) (*mcp.Token, error) {
	var (
		token    *mcp.Token
		replayed bool
	)

	err := inTx(ctx, r.pool, nil, func(tx *txn) error {
		const find = `
			SELECT ` + tokenColumns + `, revoked_at, expires_at > now()
			  FROM mcp_tokens
			 WHERE token_hash = $1 AND kind = 'refresh'
			   FOR UPDATE`

		var (
			found     mcp.Token
			revokedAt *time.Time
			live      bool
		)

		err := tx.QueryRow(ctx, find, hash).Scan(
			&found.ID, &found.VaultID, &found.UserID, &found.ClientID, &found.Kind,
			&found.Label, &found.ChainID, &found.ExpiresAt, &revokedAt, &live)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return mcp.ErrNotFound
			}

			return fmt.Errorf("select refresh token: %w", err)
		}

		if revokedAt != nil {
			const burn = `
				UPDATE mcp_tokens SET revoked_at = now()
				 WHERE revoked_at IS NULL AND (chain_id = $1 OR id = $1)`

			chain := found.ID
			if found.ChainID != nil {
				chain = *found.ChainID
			}

			if _, err := tx.Exec(ctx, burn, chain); err != nil {
				return fmt.Errorf("burn the rotation chain: %w", err)
			}

			// Reported after the commit, not from inside it: returning the error here would
			// roll the transaction back and undo the very revocation it is reporting.
			replayed = true

			return nil
		}

		if !live {
			return mcp.ErrNotFound
		}

		const spend = `UPDATE mcp_tokens SET revoked_at = now(), last_used_at = now() WHERE id = $1`

		if _, err := tx.Exec(ctx, spend, found.ID); err != nil {
			return fmt.Errorf("spend refresh token: %w", err)
		}

		token = &found

		return nil
	})
	if err != nil {
		return nil, err
	}

	if replayed {
		return nil, mcp.ErrTokenReplayed
	}

	return token, nil
}

// RevokeVaultTokens signs the connector out without taking its key away.
func (r *MCPRepository) RevokeVaultTokens(ctx context.Context, vaultID int64) error {
	const revoke = `UPDATE mcp_tokens SET revoked_at = now() WHERE vault_id = $1 AND revoked_at IS NULL`

	if _, err := r.pool.Exec(ctx, revoke, vaultID); err != nil {
		return fmt.Errorf("revoke connector tokens: %w", err)
	}

	return nil
}

// Credentials lists what is outstanding, with nothing in it that could be used as one.
func (r *MCPRepository) Credentials(ctx context.Context, vaultID int64) ([]mcp.TokenSummary, error) {
	const query = `
		SELECT id, kind, label, created_at, last_used_at, expires_at
		  FROM mcp_tokens
		 WHERE vault_id = $1 AND revoked_at IS NULL AND expires_at > now()
		 ORDER BY created_at DESC`

	rows, err := r.pool.Query(ctx, query, vaultID)
	if err != nil {
		return nil, fmt.Errorf("select connector credentials: %w", err)
	}
	defer rows.Close()

	summaries := make([]mcp.TokenSummary, 0)

	for rows.Next() {
		var summary mcp.TokenSummary

		err := rows.Scan(&summary.ID, &summary.Kind, &summary.Label,
			&summary.CreatedAt, &summary.LastUsedAt, &summary.ExpiresAt)
		if err != nil {
			return nil, fmt.Errorf("scan connector credential: %w", err)
		}

		summaries = append(summaries, summary)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate connector credentials: %w", err)
	}

	return summaries, nil
}

func scanToken(row pgx.Row) (*mcp.Token, error) {
	var token mcp.Token

	err := row.Scan(&token.ID, &token.VaultID, &token.UserID, &token.ClientID,
		&token.Kind, &token.Label, &token.ChainID, &token.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, mcp.ErrNotFound
		}

		return nil, fmt.Errorf("scan connector token: %w", err)
	}

	return &token, nil
}
