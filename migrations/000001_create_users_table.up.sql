-- Base schema: users, sessions, recovery_keys, vaults, folders, files
-- The folders tree: adjacency list (parent_id)

-- Shared trigger for updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS trigger AS
$$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- users
-- The server never sees the password and the master key: it stores only the server-side hash
-- of the client auth_hash and the keys wrapped on the client side.
CREATE TABLE IF NOT EXISTS users
(
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    login               TEXT        NOT NULL,
    auth_hash           TEXT        NOT NULL,
    kdf_salt            BYTEA       NOT NULL,
    kdf_params          JSONB       NOT NULL,
    wrapped_master_key  BYTEA       NOT NULL,
    master_key_nonce    BYTEA       NOT NULL,
    public_key          BYTEA       NOT NULL,
    wrapped_private_key BYTEA       NOT NULL,
    private_key_nonce   BYTEA       NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (char_length(login) BETWEEN 3 AND 64)
);

-- the login case does not affect uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS users_login_lower_key ON users (lower(login));

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE
    ON users
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- recovery keys for access recovery: the master key wrapped with the recovery code.
-- verifier_hash is the server-side hash of recovery_auth_hash, derived by the client from the same code:
-- without it the server cannot make sure the party recovering access owns the code.
-- One key per user, rotation is an UPSERT on user_id.
CREATE TABLE IF NOT EXISTS recovery_keys
(
    user_id            BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    verifier_hash      TEXT        NOT NULL,
    wrapped_master_key BYTEA       NOT NULL,
    nonce              BYTEA       NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- sessions stores refresh tokens: the database holds only the sha256 of the issued token
CREATE TABLE IF NOT EXISTS sessions
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   BYTEA       NOT NULL,
    user_agent   TEXT        NOT NULL DEFAULT '',
    ip           INET,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- vaults
CREATE TABLE IF NOT EXISTS vaults
(
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    emoji      TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vaults_user_id_idx ON vaults (user_id);

CREATE TRIGGER trg_vaults_updated_at
    BEFORE UPDATE
    ON vaults
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- folders - adjacency list
CREATE TABLE IF NOT EXISTS folders
(
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id   BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    parent_id  BIGINT REFERENCES folders (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders (parent_id);
CREATE INDEX IF NOT EXISTS folders_vault_id_idx ON folders (vault_id);

-- name uniqueness within a single parent
CREATE UNIQUE INDEX IF NOT EXISTS folders_parent_name_key
    ON folders (vault_id, parent_id, name)
    WHERE parent_id IS NOT NULL;

-- name uniqueness among the folders at the vault root
CREATE UNIQUE INDEX IF NOT EXISTS folders_root_name_key
    ON folders (vault_id, name)
    WHERE parent_id IS NULL;

CREATE TRIGGER trg_folders_updated_at
    BEFORE UPDATE
    ON folders
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- files
CREATE TABLE IF NOT EXISTS files
(
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id   BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    folder_id  BIGINT REFERENCES folders (id) ON DELETE CASCADE,
    title      TEXT        NOT NULL,
    content    TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_vault_id_idx ON files (vault_id);
CREATE INDEX IF NOT EXISTS files_folder_id_idx ON files (folder_id);

CREATE TRIGGER trg_files_updated_at
    BEFORE UPDATE
    ON files
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
