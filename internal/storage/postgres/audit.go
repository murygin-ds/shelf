package postgres

import (
	"context"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

// auditEntry is one row waiting to be written alongside the change it describes.
type auditEntry struct {
	VaultID     int64
	ActorID     int64
	Action      vault.AuditAction
	TargetType  string
	TargetID    int64
	SubjectType string
	SubjectID   int64
	Detail      string
}

// recordAudit appends to the log from inside the transaction that made the change. Writing
// it separately would allow the two to disagree, and a log that can disagree with reality
// is worse than none.
func recordAudit(ctx context.Context, tx pgx.Tx, e auditEntry) error {
	const query = `
		INSERT INTO audit_events (vault_id, actor_id, action, target_type, target_id,
		                          subject_type, subject_id, detail)
		VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, 0), NULLIF($6, ''), NULLIF($7, 0),
		        COALESCE(NULLIF($8, '')::JSONB, '{}'::JSONB))`

	_, err := tx.Exec(ctx, query,
		e.VaultID, e.ActorID, e.Action, e.TargetType, e.TargetID,
		e.SubjectType, e.SubjectID, e.Detail,
	)
	if err != nil {
		return fmt.Errorf("record audit event: %w", err)
	}

	return nil
}

// AuditEvents reads a page of the log, newest first. The cursor is the id of the oldest
// entry already seen, so a page cannot shift under a concurrent write the way an offset can.
func (r *VaultRepository) AuditEvents(
	ctx context.Context,
	vaultID, before int64,
	limit int,
) ([]vault.AuditEvent, error) {
	const query = `
		SELECT e.id, e.actor_id, COALESCE(u.login, ''), COALESCE(u.display_name, ''),
		       e.action, COALESCE(e.target_type, ''), e.target_id,
		       COALESCE(e.subject_type, ''), e.subject_id, e.detail, e.created_at
		  FROM audit_events e
		  LEFT JOIN users u ON u.id = e.actor_id
		 WHERE e.vault_id = $1 AND ($2 = 0 OR e.id < $2)
		 ORDER BY e.id DESC
		 LIMIT $3`

	rows, err := r.pool.Query(ctx, query, vaultID, before, limit)
	if err != nil {
		return nil, fmt.Errorf("select audit events: %w", err)
	}
	defer rows.Close()

	events := make([]vault.AuditEvent, 0, limit)

	for rows.Next() {
		var e vault.AuditEvent

		err := rows.Scan(
			&e.ID, &e.ActorID, &e.ActorLogin, &e.ActorName,
			&e.Action, &e.TargetType, &e.TargetID,
			&e.SubjectType, &e.SubjectID, &e.Detail, &e.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan audit event: %w", err)
		}

		events = append(events, e)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate audit events: %w", err)
	}

	return events, nil
}
