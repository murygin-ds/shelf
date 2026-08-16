-- Re-keying as a resumable job.
--
-- Giving a folder its own key, or rotating one after a removal, means the browser decrypts
-- and re-encrypts everything under it. That does not fit in one request: the write timeout
-- is ten seconds and a vault can hold thousands of notes. So the client stages the
-- re-encrypted rows here and one commit swaps them in.
--
-- A tab that dies mid-way leaves staging rows, not a half-encrypted vault.
CREATE TABLE IF NOT EXISTS key_rekeys
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id     BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    scope_type   TEXT        NOT NULL,
    scope_ref_id BIGINT      NOT NULL,
    -- Set when the job creates a scope rather than rotating one: the sealed keys name the
    -- scope, and the client has to know that name before the row exists.
    new_scope_client_id UUID,
    from_version INT         NOT NULL,
    to_version   INT         NOT NULL,
    status       TEXT        NOT NULL DEFAULT 'staging',
    started_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (scope_type IN ('vault', 'folder', 'file')),
    CHECK (status IN ('staging', 'committed', 'aborted')),
    CHECK (to_version > 0)
);

-- One job at a time per node: two clients re-encrypting the same subtree would each stage
-- a different key and the last commit would orphan the other one's ciphertext.
CREATE UNIQUE INDEX IF NOT EXISTS key_rekeys_active_key
    ON key_rekeys (scope_type, scope_ref_id) WHERE status = 'staging';
CREATE INDEX IF NOT EXISTS key_rekeys_vault_idx ON key_rekeys (vault_id);

CREATE TRIGGER trg_key_rekeys_updated_at
    BEFORE UPDATE
    ON key_rekeys
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS key_rekey_items
(
    rekey_id      BIGINT      NOT NULL REFERENCES key_rekeys (id) ON DELETE CASCADE,
    entity_type   TEXT        NOT NULL,
    entity_id     BIGINT      NOT NULL,
    meta          BYTEA       NOT NULL,
    meta_nonce    BYTEA       NOT NULL,
    content       BYTEA,
    content_nonce BYTEA,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (rekey_id, entity_type, entity_id),
    CHECK (entity_type IN ('vault', 'folder', 'file')),
    -- A note without a body would come back empty; folders and the vault row have none.
    CHECK ((entity_type = 'file') = (content IS NOT NULL))
);

-- Server-generated, so plaintext by nature. It names ids only: a reader renders titles from
-- their own decrypted tree, and rows about nodes they cannot see stay anonymous.
CREATE TABLE IF NOT EXISTS audit_events
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id     BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    actor_id     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    action       TEXT        NOT NULL,
    target_type  TEXT,
    target_id    BIGINT,
    subject_type TEXT,
    subject_id   BIGINT,
    detail       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_vault_idx ON audit_events (vault_id, id DESC);
