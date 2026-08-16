package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/netip"

	"shelf/internal/auth"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// uniqueViolation is the PostgreSQL error code of a unique index violation.
const uniqueViolation = "23505"

const userColumns = `id, login, display_name, auth_hash, kdf_salt, kdf_params, wrapped_master_key,
	master_key_nonce, public_key, wrapped_private_key, private_key_nonce, created_at, updated_at`

// AuthRepository implements auth.Repository on top of PostgreSQL.
type AuthRepository struct {
	pool *pgxpool.Pool
}

// NewAuthRepository creates the account and session repository.
func NewAuthRepository(pool *pgxpool.Pool) *AuthRepository {
	return &AuthRepository{pool: pool}
}

// CreateUser creates the user together with the recovery key in a single transaction.
func (r *AuthRepository) CreateUser(ctx context.Context, in auth.NewUser) (*auth.User, error) {
	var user *auth.User

	err := r.inTx(ctx, func(tx pgx.Tx) error {
		const insertUser = `
			INSERT INTO users (login, display_name, auth_hash, kdf_salt, kdf_params, wrapped_master_key,
			                   master_key_nonce, public_key, wrapped_private_key, private_key_nonce)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			RETURNING ` + userColumns

		row := tx.QueryRow(ctx, insertUser,
			in.Login, in.DisplayName, in.AuthHash, in.Keys.KDFSalt, in.Keys.KDFParams, in.Keys.WrappedMasterKey,
			in.Keys.MasterKeyNonce, in.Keys.PublicKey, in.Keys.WrappedPrivateKey, in.Keys.PrivateKeyNonce,
		)

		created, err := scanUser(row)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
				return auth.ErrLoginTaken
			}

			return fmt.Errorf("insert user: %w", err)
		}

		const insertRecovery = `
			INSERT INTO recovery_keys (user_id, verifier_hash, wrapped_master_key, nonce)
			VALUES ($1, $2, $3, $4)`

		_, err = tx.Exec(ctx, insertRecovery,
			created.ID, in.Recovery.VerifierHash, in.Recovery.WrappedMasterKey, in.Recovery.Nonce,
		)
		if err != nil {
			return fmt.Errorf("insert recovery key: %w", err)
		}

		user = created

		return nil
	})
	if err != nil {
		return nil, err
	}

	return user, nil
}

// UserByLogin looks the user up ignoring the login case.
func (r *AuthRepository) UserByLogin(ctx context.Context, login string) (*auth.User, error) {
	const query = `SELECT ` + userColumns + ` FROM users WHERE lower(login) = lower($1)`

	user, err := scanUser(r.pool.QueryRow(ctx, query, login))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, auth.ErrUserNotFound
		}

		return nil, fmt.Errorf("select user by login: %w", err)
	}

	return user, nil
}

// UserByID returns the user by identifier.
func (r *AuthRepository) UserByID(ctx context.Context, id int64) (*auth.User, error) {
	const query = `SELECT ` + userColumns + ` FROM users WHERE id = $1`

	user, err := scanUser(r.pool.QueryRow(ctx, query, id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, auth.ErrUserNotFound
		}

		return nil, fmt.Errorf("select user by id: %w", err)
	}

	return user, nil
}

// ResetCredentials updates the authentication data, rotates the recovery key
// when needed and revokes all sessions of the user.
func (r *AuthRepository) ResetCredentials(ctx context.Context, userID int64, in auth.Credentials) error {
	return r.inTx(ctx, func(tx pgx.Tx) error {
		const updateUser = `
			UPDATE users
			SET auth_hash = $2, kdf_salt = $3, kdf_params = $4,
			    wrapped_master_key = $5, master_key_nonce = $6
			WHERE id = $1`

		tag, err := tx.Exec(ctx, updateUser,
			userID, in.AuthHash, in.KDFSalt, in.KDFParams, in.WrappedMasterKey, in.MasterKeyNonce,
		)
		if err != nil {
			return fmt.Errorf("update credentials: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return auth.ErrUserNotFound
		}

		if in.Recovery != nil {
			const upsertRecovery = `
				INSERT INTO recovery_keys (user_id, verifier_hash, wrapped_master_key, nonce)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (user_id) DO UPDATE
				SET verifier_hash = EXCLUDED.verifier_hash,
				    wrapped_master_key = EXCLUDED.wrapped_master_key,
				    nonce = EXCLUDED.nonce,
				    created_at = now()`

			_, err := tx.Exec(ctx, upsertRecovery,
				userID, in.Recovery.VerifierHash, in.Recovery.WrappedMasterKey, in.Recovery.Nonce,
			)
			if err != nil {
				return fmt.Errorf("upsert recovery key: %w", err)
			}
		}

		const revokeSessions = `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`

		if _, err := tx.Exec(ctx, revokeSessions, userID); err != nil {
			return fmt.Errorf("revoke sessions: %w", err)
		}

		return nil
	})
}

// RecoveryKeyByLogin returns the recovery key of the user by login.
func (r *AuthRepository) RecoveryKeyByLogin(ctx context.Context, login string) (*auth.RecoveryKey, error) {
	const query = `
		SELECT rk.user_id, rk.verifier_hash, rk.wrapped_master_key, rk.nonce
		FROM recovery_keys rk
		JOIN users u ON u.id = rk.user_id
		WHERE lower(u.login) = lower($1)`

	var key auth.RecoveryKey

	err := r.pool.QueryRow(ctx, query, login).
		Scan(&key.UserID, &key.VerifierHash, &key.WrappedMasterKey, &key.Nonce)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, auth.ErrUserNotFound
		}

		return nil, fmt.Errorf("select recovery key: %w", err)
	}

	return &key, nil
}

// CreateSession stores a new session.
func (r *AuthRepository) CreateSession(ctx context.Context, in auth.NewSession) (*auth.Session, error) {
	session, err := insertSession(ctx, r.pool, in)
	if err != nil {
		return nil, err
	}

	return session, nil
}

// SessionByTokenHash looks a session up by the refresh token hash, revoked ones included:
// a revoked session is what makes token reuse detectable.
func (r *AuthRepository) SessionByTokenHash(ctx context.Context, tokenHash []byte) (*auth.Session, error) {
	const query = `
		SELECT id, user_id, user_agent, ip, expires_at, revoked_at, created_at, last_used_at
		FROM sessions
		WHERE token_hash = $1`

	session, err := scanSession(r.pool.QueryRow(ctx, query, tokenHash))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, auth.ErrSessionNotFound
		}

		return nil, fmt.Errorf("select session: %w", err)
	}

	return session, nil
}

// RotateSession revokes the old session and creates a new one in a single transaction.
func (r *AuthRepository) RotateSession(ctx context.Context, oldID int64, in auth.NewSession) (*auth.Session, error) {
	var session *auth.Session

	err := r.inTx(ctx, func(tx pgx.Tx) error {
		const revoke = `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`

		tag, err := tx.Exec(ctx, revoke, oldID)
		if err != nil {
			return fmt.Errorf("revoke rotated session: %w", err)
		}

		// Zero rows mean the session was revoked by a concurrent request.
		if tag.RowsAffected() == 0 {
			return auth.ErrSessionNotFound
		}

		created, err := insertSession(ctx, tx, in)
		if err != nil {
			return err
		}

		session = created

		return nil
	})
	if err != nil {
		return nil, err
	}

	return session, nil
}

// RevokeSessionByTokenHash revokes the session by the refresh token hash.
func (r *AuthRepository) RevokeSessionByTokenHash(ctx context.Context, tokenHash []byte) error {
	const query = `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`

	if _, err := r.pool.Exec(ctx, query, tokenHash); err != nil {
		return fmt.Errorf("revoke session by token: %w", err)
	}

	return nil
}

// RevokeSession revokes a session of the user by identifier.
func (r *AuthRepository) RevokeSession(ctx context.Context, userID, sessionID int64) error {
	const query = `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`

	tag, err := r.pool.Exec(ctx, query, sessionID, userID)
	if err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}

	if tag.RowsAffected() == 0 {
		return auth.ErrSessionNotFound
	}

	return nil
}

// RevokeUserSessions revokes all active sessions of the user.
func (r *AuthRepository) RevokeUserSessions(ctx context.Context, userID int64) error {
	const query = `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`

	if _, err := r.pool.Exec(ctx, query, userID); err != nil {
		return fmt.Errorf("revoke user sessions: %w", err)
	}

	return nil
}

// ListSessions returns the active sessions of the user, most recent first.
func (r *AuthRepository) ListSessions(ctx context.Context, userID int64) ([]auth.Session, error) {
	const query = `
		SELECT id, user_id, user_agent, ip, expires_at, revoked_at, created_at, last_used_at
		FROM sessions
		WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
		ORDER BY last_used_at DESC`

	rows, err := r.pool.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("select sessions: %w", err)
	}
	defer rows.Close()

	var sessions []auth.Session

	for rows.Next() {
		session, err := scanSession(rows)
		if err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}

		sessions = append(sessions, *session)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sessions: %w", err)
	}

	return sessions, nil
}

// querier unites the pool and a transaction: some queries run in both contexts.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func insertSession(ctx context.Context, q querier, in auth.NewSession) (*auth.Session, error) {
	const query = `
		INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, user_id, user_agent, ip, expires_at, revoked_at, created_at, last_used_at`

	session, err := scanSession(q.QueryRow(ctx, query, in.UserID, in.TokenHash, in.UserAgent, nullableIP(in.IP), in.ExpiresAt))
	if err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}

	return session, nil
}

func (r *AuthRepository) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := r.pool.Begin(ctx)
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

func scanUser(row pgx.Row) (*auth.User, error) {
	var user auth.User

	err := row.Scan(
		&user.ID, &user.Login, &user.DisplayName, &user.AuthHash, &user.Keys.KDFSalt, &user.Keys.KDFParams,
		&user.Keys.WrappedMasterKey, &user.Keys.MasterKeyNonce, &user.Keys.PublicKey,
		&user.Keys.WrappedPrivateKey, &user.Keys.PrivateKeyNonce, &user.CreatedAt, &user.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	return &user, nil
}

func scanSession(row pgx.Row) (*auth.Session, error) {
	var (
		session auth.Session
		ip      *netip.Addr
	)

	err := row.Scan(
		&session.ID, &session.UserID, &session.UserAgent, &ip,
		&session.ExpiresAt, &session.RevokedAt, &session.CreatedAt, &session.LastUsedAt,
	)
	if err != nil {
		return nil, err
	}

	if ip != nil {
		session.IP = *ip
	}

	return &session, nil
}

// nullableIP turns an invalid address into NULL: pgx cannot encode an empty netip.Addr.
func nullableIP(addr netip.Addr) any {
	if !addr.IsValid() {
		return nil
	}

	return addr
}
