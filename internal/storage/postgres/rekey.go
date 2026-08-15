package postgres

import (
	"context"
	"errors"
	"fmt"

	"shelf/internal/vault"

	"github.com/jackc/pgx/v5"
)

// The scope's own client id wins over the staged one: a rotation keeps the scope it
// rotates, so the rows it rewrites must keep naming it.
const rekeyColumns = `id, vault_id, scope_type, scope_ref_id,
	COALESCE(
	    (SELECT ks.client_id::TEXT FROM key_scopes ks
	      WHERE ks.scope_type = key_rekeys.scope_type
	        AND ks.scope_ref_id = key_rekeys.scope_ref_id),
	    new_scope_client_id::TEXT, ''),
	from_version, to_version, status, expires_at`

// StartRekey plans the job: which rows fall under the scope, and whose keys the new one
// has to be sealed to. Both are read at plan time so the client knows the full extent
// before it starts decrypting anything.
func (r *VaultRepository) StartRekey(ctx context.Context, in vault.NewRekey) (*vault.RekeyPlan, error) {
	var plan *vault.RekeyPlan

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		// An abandoned job must not lock the node forever.
		const reap = `
			UPDATE key_rekeys SET status = 'aborted'
			 WHERE scope_type = $1 AND scope_ref_id = $2 AND status = 'staging' AND expires_at <= now()`

		if _, err := tx.Exec(ctx, reap, in.ScopeType, in.ScopeRefID); err != nil {
			return fmt.Errorf("reap expired rekeys: %w", err)
		}

		const sweep = `
			DELETE FROM key_rekey_items i
			 USING key_rekeys k
			 WHERE k.id = i.rekey_id AND k.status <> 'staging'
			   AND k.scope_type = $1 AND k.scope_ref_id = $2`

		if _, err := tx.Exec(ctx, sweep, in.ScopeType, in.ScopeRefID); err != nil {
			return fmt.Errorf("sweep staged rows: %w", err)
		}

		var (
			existingScope int64
			fromVersion   int32
		)

		const current = `
			SELECT id, key_version FROM key_scopes
			 WHERE scope_type = $1 AND scope_ref_id = $2`

		err := tx.QueryRow(ctx, current, in.ScopeType, in.ScopeRefID).Scan(&existingScope, &fromVersion)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("select current scope: %w", err)
		}

		creates := errors.Is(err, pgx.ErrNoRows)

		// A new scope starts at version 1; an existing one moves forward.
		toVersion := fromVersion + 1
		if creates {
			if in.NewScopeClientID == "" {
				return vault.ErrKeyGrantMissing
			}

			fromVersion, toVersion = 0, 1
		}

		const insert = `
			INSERT INTO key_rekeys (vault_id, scope_type, scope_ref_id, new_scope_client_id,
			                        from_version, to_version, started_by, expires_at)
			VALUES ($1, $2, $3, NULLIF($4, '')::UUID, $5, $6, $7, $8)
			RETURNING ` + rekeyColumns

		row := tx.QueryRow(ctx, insert,
			in.VaultID, in.ScopeType, in.ScopeRefID, in.NewScopeClientID,
			fromVersion, toVersion, in.ActorID, in.ExpiresAt,
		)

		job, err := scanRekey(row)
		if err != nil {
			if isUniqueViolation(err) {
				// Two clients re-encrypting the same subtree would each stage a different
				// key, and the second commit would orphan the first one's ciphertext.
				return vault.ErrVersionConflict
			}

			return fmt.Errorf("insert rekey: %w", err)
		}

		folders, files, coversVault, err := rekeyExtent(ctx, tx, in.ScopeType, in.ScopeRefID, existingScope, creates)
		if err != nil {
			return err
		}

		subjects, err := rekeySubjects(ctx, tx, in.VaultID, in.ScopeType, in.ScopeRefID, existingScope, creates)
		if err != nil {
			return err
		}

		plan = &vault.RekeyPlan{
			Rekey:    *job,
			Creates:  creates,
			Vault:    coversVault,
			Folders:  folders,
			Files:    files,
			Subjects: subjects,
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return plan, nil
}

// rekeyExtent lists the rows the new key will cover.
//
// Creating a scope claims the subtree that currently inherits from above; rotating one
// takes whatever already points at it. Nodes that own a scope of their own are left alone
// either way — they are already separate.
func rekeyExtent(
	ctx context.Context,
	tx pgx.Tx,
	scopeType vault.ScopeType,
	scopeRefID, existingScope int64,
	creates bool,
) (folders, files []int64, coversVault bool, err error) {
	if !creates {
		if scopeType == vault.ScopeVault {
			coversVault = true
		}

		const byScope = `SELECT id FROM folders WHERE key_scope_id = $1 ORDER BY id`
		if folders, err = ids(ctx, tx, byScope, existingScope); err != nil {
			return nil, nil, false, err
		}

		const filesByScope = `SELECT id FROM files WHERE key_scope_id = $1 ORDER BY id`
		if files, err = ids(ctx, tx, filesByScope, existingScope); err != nil {
			return nil, nil, false, err
		}

		return folders, files, coversVault, nil
	}

	if scopeType == vault.ScopeFile {
		return []int64{}, []int64{scopeRefID}, false, nil
	}

	if folders, err = ids(ctx, tx, subtreeFolders, scopeRefID); err != nil {
		return nil, nil, false, err
	}

	if files, err = ids(ctx, tx, subtreeFiles, scopeRefID); err != nil {
		return nil, nil, false, err
	}

	return folders, files, false, nil
}

// subtreeCTE walks down from a folder, stopping at any descendant that already owns a key
// scope: its contents are encrypted under a key this job has nothing to do with.
const subtreeCTE = `
	WITH RECURSIVE tree AS (
	    SELECT f.id FROM folders f WHERE f.id = $1
	    UNION ALL
	    SELECT c.id
	      FROM folders c
	      JOIN tree t ON c.parent_id = t.id
	     WHERE NOT EXISTS (
	         SELECT 1 FROM key_scopes ks
	          WHERE ks.scope_type = 'folder' AND ks.scope_ref_id = c.id
	     )
	)`

const subtreeFolders = subtreeCTE + ` SELECT id FROM tree ORDER BY id`

const subtreeFiles = subtreeCTE + `
	SELECT fi.id
	  FROM files fi
	 WHERE fi.folder_id IN (SELECT id FROM tree)
	   AND NOT EXISTS (
	       SELECT 1 FROM key_scopes ks
	        WHERE ks.scope_type = 'file' AND ks.scope_ref_id = fi.id
	   )
	 ORDER BY fi.id`

// rekeySubjects lists who keeps the key.
//
// For a rotation that is everyone who still holds a grant at the current version — the
// removal already deleted the grants of anyone who lost access, which is exactly what
// makes this list the answer rather than a guess.
//
// For a new scope it is everyone the permission query says may still read the node.
func rekeySubjects(
	ctx context.Context,
	tx pgx.Tx,
	vaultID int64,
	scopeType vault.ScopeType,
	scopeRefID, existingScope int64,
	creates bool,
) ([]vault.RekeySubject, error) {
	const holders = `
		SELECT u.id, u.login, u.display_name, u.public_key
		  FROM key_grants kg
		  JOIN key_scopes ks ON ks.id = kg.scope_id AND kg.key_version = ks.key_version
		  JOIN users u ON u.id = kg.subject_id
		 WHERE ks.id = $1 AND kg.subject_type = 'user'
		 ORDER BY u.id`

	// Everyone whose effective permission on this node still allows reading it. A denial
	// set beforehand is therefore honoured here, which is exactly what turns a
	// server-enforced denial into a cryptographic one.
	const entitled = `
		SELECT u.id, u.login, u.display_name, u.public_key
		  FROM vault_members m
		  JOIN users u ON u.id = m.user_id
		 WHERE m.vault_id = $1
		   AND permission_rank(COALESCE(
		       (SELECT g.permission FROM grants g
		         WHERE g.scope_type = $2 AND g.scope_ref_id = $3
		           AND g.subject_type = 'user' AND g.subject_id = m.user_id),
		       role_permission(m.role))) > 0
		 ORDER BY u.id`

	var rows pgx.Rows
	var err error

	if creates {
		rows, err = tx.Query(ctx, entitled, vaultID, scopeType, scopeRefID)
	} else {
		rows, err = tx.Query(ctx, holders, existingScope)
	}

	if err != nil {
		return nil, fmt.Errorf("select rekey subjects: %w", err)
	}
	defer rows.Close()

	subjects := make([]vault.RekeySubject, 0)

	for rows.Next() {
		var s vault.RekeySubject

		if err := rows.Scan(&s.UserID, &s.Login, &s.DisplayName, &s.PublicKey); err != nil {
			return nil, fmt.Errorf("scan rekey subject: %w", err)
		}

		subjects = append(subjects, s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rekey subjects: %w", err)
	}

	return subjects, nil
}

func (r *VaultRepository) Rekey(ctx context.Context, rekeyID int64) (*vault.Rekey, error) {
	const query = `SELECT ` + rekeyColumns + ` FROM key_rekeys WHERE id = $1`

	job, err := scanRekey(r.pool.QueryRow(ctx, query, rekeyID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, vault.ErrNotFound
		}

		return nil, fmt.Errorf("select rekey: %w", err)
	}

	return job, nil
}

func (r *VaultRepository) StageRekeyItems(ctx context.Context, rekeyID int64, items []vault.RekeyItem) error {
	return inTx(ctx, r.pool, func(tx pgx.Tx) error {
		const upsert = `
			INSERT INTO key_rekey_items (rekey_id, entity_type, entity_id, meta, meta_nonce, content, content_nonce)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (rekey_id, entity_type, entity_id)
			DO UPDATE SET meta = EXCLUDED.meta, meta_nonce = EXCLUDED.meta_nonce,
			              content = EXCLUDED.content, content_nonce = EXCLUDED.content_nonce`

		for _, item := range items {
			var content, contentNonce []byte
			if item.Content != nil {
				content, contentNonce = item.Content.Ciphertext, item.Content.Nonce
			}

			_, err := tx.Exec(ctx, upsert, rekeyID, item.EntityType, item.EntityID,
				item.Meta.Ciphertext, item.Meta.Nonce, content, contentNonce)
			if err != nil {
				return fmt.Errorf("stage rekey item: %w", err)
			}
		}

		return nil
	})
}

// CommitRekey applies the job in one transaction.
//
// The order matters and the atomicity matters more: the scope moves to the new version,
// every staged row is swapped in and repointed at it, the new grants land, and the grants
// of anyone no longer entitled are dropped at every version. Any prefix of that applied
// alone would leave rows sealed under a key nobody was given.
func (r *VaultRepository) CommitRekey(
	ctx context.Context,
	rekeyID, actorID int64,
	grants []vault.RekeyGrant,
) (*vault.KeyScope, error) {
	var scope *vault.KeyScope

	err := inTx(ctx, r.pool, func(tx pgx.Tx) error {
		const claim = `
			UPDATE key_rekeys SET status = 'committed'
			 WHERE id = $1 AND status = 'staging' AND expires_at > now()
			RETURNING ` + rekeyColumns

		job, err := scanRekey(tx.QueryRow(ctx, claim, rekeyID))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return vault.ErrRekeyStale
			}

			return fmt.Errorf("claim rekey: %w", err)
		}

		seq, err := nextSeq(ctx, tx, job.VaultID)
		if err != nil {
			return err
		}

		scope, err = upsertScope(ctx, tx, job)
		if err != nil {
			return err
		}

		if err := applyStagedItems(ctx, tx, job, scope.ID, actorID, seq); err != nil {
			return err
		}

		users, groups := keptSubjects(grants)

		// Everyone not on the new list loses the scope at every version — that is what makes
		// the revocation retroactive. Everyone on it keeps their old versions: the trash and
		// the revision history are still sealed under them.
		const dropRevoked = `
			DELETE FROM key_grants
			 WHERE scope_id = $1
			   AND NOT (subject_type = 'user' AND subject_id = ANY($2))
			   AND NOT (subject_type = 'group' AND subject_id = ANY($3))`

		if _, err := tx.Exec(ctx, dropRevoked, scope.ID, users, groups); err != nil {
			return fmt.Errorf("delete revoked key grants: %w", err)
		}

		for _, grant := range grants {
			const insert = `
				INSERT INTO key_grants (scope_id, key_version, subject_type, subject_id,
				                        wrapped_key, nonce, wrap_algorithm, granted_by)
				VALUES ($1, $2, $3, $4, $5, $6, COALESCE(NULLIF($7, ''), 'ecdh-p256-hkdf-a256gcm'), $8)
				ON CONFLICT (scope_id, key_version, subject_type, subject_id) DO NOTHING`

			_, err := tx.Exec(ctx, insert, scope.ID, scope.KeyVersion,
				grant.Subject.Type, grant.Subject.ID, grant.WrappedKey, grant.Nonce,
				grant.Algorithm, actorID)
			if err != nil {
				return fmt.Errorf("insert key grant: %w", err)
			}
		}

		// A node given its own key stops inheriting: that is the whole point of the move.
		//
		// Detaching alone would leave the node with keys and no permissions — the same
		// invariant this codebase enforces in the other direction — so the people who keep
		// the key are written in as explicit grants first, at the permission they had a
		// moment ago. The expression is the one the plan used to pick them, so what the
		// client was shown and what lands here cannot disagree.
		if job.FromVersion == 0 {
			const pin = `
				INSERT INTO grants (vault_id, scope_type, scope_ref_id, subject_type, subject_id,
				                    permission, created_by)
				SELECT $1, $2, $3, 'user', m.user_id,
				       COALESCE((SELECT g.permission FROM grants g
				                  WHERE g.scope_type = $2 AND g.scope_ref_id = $3
				                    AND g.subject_type = 'user' AND g.subject_id = m.user_id),
				                role_permission(m.role)),
				       $4
				  FROM vault_members m
				 WHERE m.vault_id = $1 AND m.user_id = ANY($5)
				ON CONFLICT (scope_type, scope_ref_id, subject_type, subject_id) DO NOTHING`

			_, err := tx.Exec(ctx, pin, job.VaultID, job.ScopeType, job.ScopeRefID, actorID, users)
			if err != nil {
				return fmt.Errorf("pin permissions to the new scope: %w", err)
			}

			if job.ScopeType == vault.ScopeFolder {
				const detach = `UPDATE folders SET inherit_access = FALSE WHERE id = $1`

				if _, err := tx.Exec(ctx, detach, job.ScopeRefID); err != nil {
					return fmt.Errorf("detach folder inheritance: %w", err)
				}
			}
		}

		const clearPending = `
			UPDATE vault_members SET key_state = 'ok', access_seq = $2
			 WHERE vault_id = $1`

		if _, err := tx.Exec(ctx, clearPending, job.VaultID, seq); err != nil {
			return fmt.Errorf("clear pending rotation: %w", err)
		}

		const drop = `DELETE FROM key_rekey_items WHERE rekey_id = $1`

		if _, err := tx.Exec(ctx, drop, job.ID); err != nil {
			return fmt.Errorf("drop staged rows: %w", err)
		}

		action := vault.AuditKeyRotated
		if job.FromVersion == 0 {
			action = vault.AuditKeyProtected
		}

		return recordAudit(ctx, tx, auditEntry{
			VaultID:    job.VaultID,
			ActorID:    actorID,
			Action:     action,
			TargetType: string(job.ScopeType),
			TargetID:   job.ScopeRefID,
			Detail: fmt.Sprintf(`{"from_version":%d,"to_version":%d,"grants":%d}`,
				job.FromVersion, job.ToVersion, len(grants)),
		})
	})
	if err != nil {
		return nil, err
	}

	return scope, nil
}

func upsertScope(ctx context.Context, tx pgx.Tx, job *vault.Rekey) (*vault.KeyScope, error) {
	var scope vault.KeyScope

	if job.FromVersion == 0 {
		const insert = `
			INSERT INTO key_scopes (client_id, vault_id, scope_type, scope_ref_id, key_version)
			VALUES ($1::UUID, $2, $3, $4, $5)
			RETURNING id, client_id, vault_id, scope_type, scope_ref_id, key_version`

		row := tx.QueryRow(ctx, insert, job.ScopeClientID, job.VaultID,
			job.ScopeType, job.ScopeRefID, job.ToVersion)

		err := row.Scan(&scope.ID, &scope.ClientID, &scope.VaultID, &scope.Type, &scope.RefID, &scope.KeyVersion)
		if err != nil {
			return nil, fmt.Errorf("insert key scope: %w", err)
		}

		return &scope, nil
	}

	const bump = `
		UPDATE key_scopes SET key_version = $3
		 WHERE scope_type = $1 AND scope_ref_id = $2
		RETURNING id, client_id, vault_id, scope_type, scope_ref_id, key_version`

	row := tx.QueryRow(ctx, bump, job.ScopeType, job.ScopeRefID, job.ToVersion)

	err := row.Scan(&scope.ID, &scope.ClientID, &scope.VaultID, &scope.Type, &scope.RefID, &scope.KeyVersion)
	if err != nil {
		return nil, fmt.Errorf("bump key scope: %w", err)
	}

	return &scope, nil
}

// applyStagedItems swaps in the re-encrypted rows and repoints them at the new scope.
func applyStagedItems(
	ctx context.Context,
	tx pgx.Tx,
	job *vault.Rekey,
	scopeID, actorID, seq int64,
) error {
	const folders = `
		UPDATE folders f
		   SET meta = i.meta, meta_nonce = i.meta_nonce,
		       key_scope_id = $2, key_version = $3,
		       updated_seq = $4, updated_by = $5
		  FROM key_rekey_items i
		 WHERE i.rekey_id = $1 AND i.entity_type = 'folder' AND f.id = i.entity_id`

	if _, err := tx.Exec(ctx, folders, job.ID, scopeID, job.ToVersion, seq, actorID); err != nil {
		return fmt.Errorf("apply staged folders: %w", err)
	}

	const vaultMeta = `
		UPDATE vaults v
		   SET meta = i.meta, meta_nonce = i.meta_nonce
		  FROM key_rekey_items i
		 WHERE i.rekey_id = $1 AND i.entity_type = 'vault' AND v.id = i.entity_id`

	if _, err := tx.Exec(ctx, vaultMeta, job.ID); err != nil {
		return fmt.Errorf("apply staged vault: %w", err)
	}

	const files = `
		UPDATE files fi
		   SET meta = i.meta, meta_nonce = i.meta_nonce,
		       content = i.content, content_nonce = i.content_nonce,
		       key_scope_id = $2, key_version = $3,
		       updated_seq = $4, updated_by = $5
		  FROM key_rekey_items i
		 WHERE i.rekey_id = $1 AND i.entity_type = 'file' AND fi.id = i.entity_id`

	if _, err := tx.Exec(ctx, files, job.ID, scopeID, job.ToVersion, seq, actorID); err != nil {
		return fmt.Errorf("apply staged files: %w", err)
	}

	return nil
}

func (r *VaultRepository) AbortRekey(ctx context.Context, rekeyID int64) error {
	return inTx(ctx, r.pool, func(tx pgx.Tx) error {
		const query = `UPDATE key_rekeys SET status = 'aborted' WHERE id = $1 AND status = 'staging'`

		tag, err := tx.Exec(ctx, query, rekeyID)
		if err != nil {
			return fmt.Errorf("abort rekey: %w", err)
		}

		if tag.RowsAffected() == 0 {
			return vault.ErrRekeyStale
		}

		const drop = `DELETE FROM key_rekey_items WHERE rekey_id = $1`

		if _, err := tx.Exec(ctx, drop, rekeyID); err != nil {
			return fmt.Errorf("drop staged rows: %w", err)
		}

		return nil
	})
}

func scanRekey(row pgx.Row) (*vault.Rekey, error) {
	var job vault.Rekey

	err := row.Scan(&job.ID, &job.VaultID, &job.ScopeType, &job.ScopeRefID,
		&job.ScopeClientID, &job.FromVersion, &job.ToVersion, &job.Status, &job.ExpiresAt)
	if err != nil {
		return nil, err
	}

	return &job, nil
}

func ids(ctx context.Context, tx pgx.Tx, query string, arg any) ([]int64, error) {
	rows, err := tx.Query(ctx, query, arg)
	if err != nil {
		return nil, fmt.Errorf("select ids: %w", err)
	}
	defer rows.Close()

	out := make([]int64, 0)

	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan id: %w", err)
		}

		out = append(out, id)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ids: %w", err)
	}

	return out, nil
}

// keptSubjects splits the new grants by subject kind. A group reaching the node through
// inheritance is not in either list and loses the scope, which is the honest outcome for a
// node that has just become an island.
func keptSubjects(grants []vault.RekeyGrant) (users, groups []int64) {
	users, groups = []int64{}, []int64{}

	for _, grant := range grants {
		switch grant.Subject.Type {
		case vault.SubjectUser:
			users = append(users, grant.Subject.ID)
		case vault.SubjectGroup:
			groups = append(groups, grant.Subject.ID)
		}
	}

	return users, groups
}
