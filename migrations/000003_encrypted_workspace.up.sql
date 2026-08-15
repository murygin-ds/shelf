-- Encrypted workspace: key scopes, key grants, membership and the re-encrypted entities.
--
-- The vaults/folders/files of 000001 were plaintext and single-owner. No Go code ever
-- referenced them and they hold no data, so they are recreated rather than altered: the
-- column set changes completely, and `user_id ... ON DELETE CASCADE` is the wrong
-- ownership model for a vault that outlives any single member.

DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS vaults;

-- The permission lattice, ordered so a query can compare two grants.
CREATE OR REPLACE FUNCTION permission_rank(p TEXT)
    RETURNS INT AS
$$
SELECT CASE p
           WHEN 'none' THEN 0
           WHEN 'view' THEN 1
           WHEN 'comment' THEN 2
           WHEN 'edit' THEN 3
           WHEN 'own' THEN 4
           END;
$$ LANGUAGE sql IMMUTABLE STRICT;

-- The floor a vault role puts under every node a member can reach.
CREATE OR REPLACE FUNCTION role_permission(r TEXT)
    RETURNS TEXT AS
$$
SELECT CASE r
           WHEN 'owner' THEN 'own'
           WHEN 'admin' THEN 'own'
           WHEN 'editor' THEN 'edit'
           WHEN 'viewer' THEN 'view'
           ELSE 'none'
           END;
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE TABLE IF NOT EXISTS vaults
(
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Identifier the client picks before the row exists. The encrypted metadata is bound
    -- to it, so a hostile server cannot move one entity's ciphertext onto another; the
    -- serial id cannot serve that purpose because it is only known after the insert.
    client_id  UUID        NOT NULL UNIQUE,
    -- RESTRICT, not CASCADE: deleting an account must not silently destroy a vault
    -- other members still hold keys to.
    owner_id   BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    meta       BYTEA       NOT NULL,
    meta_nonce BYTEA       NOT NULL,
    -- Monotonic per-vault cursor. Every write bumps it inside the same transaction, so a
    -- delta sync cannot miss a row the way a timestamp cursor silently can.
    change_seq BIGINT      NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vaults_owner_id_idx ON vaults (owner_id);

CREATE TRIGGER trg_vaults_updated_at
    BEFORE UPDATE
    ON vaults
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- A key scope owns exactly one content key. The vault always owns one; a folder or a file
-- owns one only once its access was narrowed away from the enclosing scope.
CREATE TABLE IF NOT EXISTS key_scopes
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Chosen by the client, like the entity ids: a scope key is sealed to a subject before
    -- the scope row exists, and the seal has to name the scope it unlocks.
    client_id    UUID        NOT NULL UNIQUE,
    vault_id     BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    scope_type   TEXT        NOT NULL,
    scope_ref_id BIGINT      NOT NULL,
    key_version  INT         NOT NULL DEFAULT 1,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (scope_type IN ('vault', 'folder', 'file')),
    CHECK (key_version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS key_scopes_ref_key ON key_scopes (scope_type, scope_ref_id);
CREATE INDEX IF NOT EXISTS key_scopes_vault_id_idx ON key_scopes (vault_id);

CREATE TRIGGER trg_key_scopes_updated_at
    BEFORE UPDATE
    ON key_scopes
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- The scope key sealed to a subject's public key. Rows are never written on their own:
-- only alongside a permission grant, a rotation commit or an invite redemption, because a
-- key grant without a matching permission is a permanent backdoor.
--
-- Old versions survive rotation for retained subjects, so revisions and trashed items
-- encrypted under an earlier version stay readable.
CREATE TABLE IF NOT EXISTS key_grants
(
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope_id       BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE CASCADE,
    key_version    INT         NOT NULL,
    subject_type   TEXT        NOT NULL,
    subject_id     BIGINT      NOT NULL,
    wrapped_key    BYTEA       NOT NULL,
    nonce          BYTEA       NOT NULL,
    wrap_algorithm TEXT        NOT NULL DEFAULT 'ecdh-p256-hkdf-a256gcm',
    granted_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (subject_type IN ('user', 'group', 'invite', 'share_link'))
);

CREATE UNIQUE INDEX IF NOT EXISTS key_grants_scope_version_subject_key
    ON key_grants (scope_id, key_version, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS key_grants_subject_idx ON key_grants (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS vault_members
(
    vault_id   BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role       TEXT        NOT NULL,
    -- pending_key: admitted, but nobody has sealed the scope keys to them yet.
    -- pending_rotation: somebody was removed and the scopes they held are not rotated yet.
    key_state  TEXT        NOT NULL DEFAULT 'ok',
    -- Bumped whenever this member's effective access changes. A sync cursor older than
    -- this forces a full resync, which is how a client learns to drop plaintext it cached
    -- before losing access to it.
    access_seq BIGINT      NOT NULL DEFAULT 0,
    invited_by BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (vault_id, user_id),
    CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
    CHECK (key_state IN ('ok', 'pending_key', 'pending_rotation'))
);

CREATE INDEX IF NOT EXISTS vault_members_user_id_idx ON vault_members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS vault_members_owner_key ON vault_members (vault_id) WHERE role = 'owner';

CREATE TRIGGER trg_vault_members_updated_at
    BEFORE UPDATE
    ON vault_members
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- A group carries its own keypair, so adding a member costs one seal of the group private
-- key instead of re-sealing every scope key the group can reach. Without it an admin who
-- is excluded from one folder could not add anyone to a group that reaches it.
CREATE TABLE IF NOT EXISTS groups
(
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id   UUID        NOT NULL,
    vault_id    BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    meta        BYTEA       NOT NULL,
    meta_nonce  BYTEA       NOT NULL,
    public_key  BYTEA       NOT NULL,
    key_version INT         NOT NULL DEFAULT 1,
    created_by  BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS groups_client_id_key ON groups (vault_id, client_id);
CREATE INDEX IF NOT EXISTS groups_vault_id_idx ON groups (vault_id);

CREATE TRIGGER trg_groups_updated_at
    BEFORE UPDATE
    ON groups
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS group_members
(
    group_id            BIGINT      NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    user_id             BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key_version         INT         NOT NULL,
    wrapped_private_key BYTEA       NOT NULL,
    nonce               BYTEA       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_members_user_id_idx ON group_members (user_id);

-- Explicit access on one node. 'none' is a deny, which is what renders a greyed row in the
-- tree; a deny only becomes cryptographic once the node owns its own key scope.
CREATE TABLE IF NOT EXISTS grants
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Chosen by the client, like the entity ids: a scope key is sealed to a subject before
    -- the scope row exists, and the seal has to name the scope it unlocks.
    client_id    UUID        NOT NULL UNIQUE,
    vault_id     BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    scope_type   TEXT        NOT NULL,
    scope_ref_id BIGINT      NOT NULL,
    subject_type TEXT        NOT NULL,
    subject_id   BIGINT      NOT NULL,
    permission   TEXT        NOT NULL,
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (scope_type IN ('folder', 'file')),
    CHECK (subject_type IN ('user', 'group')),
    CHECK (permission IN ('none', 'view', 'comment', 'edit', 'own'))
);

CREATE UNIQUE INDEX IF NOT EXISTS grants_target_subject_key
    ON grants (scope_type, scope_ref_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS grants_vault_id_idx ON grants (vault_id);

CREATE TRIGGER trg_grants_updated_at
    BEFORE UPDATE
    ON grants
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- folders - adjacency list. Names live inside the encrypted meta blob, so the plaintext
-- uniqueness indexes of 000001 cannot be kept: siblings may sit in different key scopes,
-- and a keyed blind index would leak title equality across the whole vault. The client
-- resolves collisions the way a filesystem does.
CREATE TABLE IF NOT EXISTS folders
(
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id      UUID        NOT NULL,
    vault_id       BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    parent_id      BIGINT REFERENCES folders (id) ON DELETE CASCADE,
    key_scope_id   BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE RESTRICT,
    key_version    INT         NOT NULL,
    meta           BYTEA       NOT NULL,
    meta_nonce     BYTEA       NOT NULL,
    inherit_access BOOLEAN     NOT NULL DEFAULT TRUE,
    depth          INT         NOT NULL DEFAULT 0,
    position       INT         NOT NULL DEFAULT 0,
    updated_seq    BIGINT      NOT NULL,
    updated_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (parent_id IS DISTINCT FROM id),
    -- Bounds the recursive descent; together with the ancestor check on move it rules out
    -- the cycle that would otherwise spin the resolution query forever.
    CHECK (depth BETWEEN 0 AND 32)
);

CREATE UNIQUE INDEX IF NOT EXISTS folders_client_id_key ON folders (vault_id, client_id);
CREATE INDEX IF NOT EXISTS folders_vault_id_idx ON folders (vault_id);
CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders (parent_id);
CREATE INDEX IF NOT EXISTS folders_vault_seq_idx ON folders (vault_id, updated_seq);
CREATE INDEX IF NOT EXISTS folders_scope_idx ON folders (key_scope_id);

CREATE TRIGGER trg_folders_updated_at
    BEFORE UPDATE
    ON folders
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS files
(
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id      UUID        NOT NULL,
    vault_id       BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    folder_id      BIGINT REFERENCES folders (id) ON DELETE CASCADE,
    key_scope_id   BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE RESTRICT,
    key_version    INT         NOT NULL,
    meta           BYTEA       NOT NULL,
    meta_nonce     BYTEA       NOT NULL,
    content        BYTEA       NOT NULL,
    content_nonce  BYTEA       NOT NULL,
    -- Optimistic concurrency token: PUT .../content carries it in If-Match. The server
    -- cannot merge ciphertext, so a stale write has to be refused rather than resolved.
    content_seq    BIGINT      NOT NULL DEFAULT 1,
    inherit_access BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_seq    BIGINT      NOT NULL,
    updated_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    deleted_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (octet_length(content) <= 4 * 1024 * 1024)
);

CREATE UNIQUE INDEX IF NOT EXISTS files_client_id_key ON files (vault_id, client_id);
CREATE INDEX IF NOT EXISTS files_vault_id_idx ON files (vault_id);
CREATE INDEX IF NOT EXISTS files_folder_id_idx ON files (folder_id);
CREATE INDEX IF NOT EXISTS files_vault_seq_idx ON files (vault_id, updated_seq);
CREATE INDEX IF NOT EXISTS files_scope_idx ON files (key_scope_id);

CREATE TRIGGER trg_files_updated_at
    BEFORE UPDATE
    ON files
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Allocates the next per-vault change sequence. The row lock serializes writes within one
-- vault, which is exactly what makes the sync cursor gap-free.
CREATE OR REPLACE FUNCTION next_vault_seq(p_vault_id BIGINT)
    RETURNS BIGINT AS
$$
DECLARE
    v_seq BIGINT;
BEGIN
    UPDATE vaults SET change_seq = change_seq + 1 WHERE id = p_vault_id RETURNING change_seq INTO v_seq;

    IF v_seq IS NULL THEN
        RAISE EXCEPTION 'vault % not found', p_vault_id USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;
