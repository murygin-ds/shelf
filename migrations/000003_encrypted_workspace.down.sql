DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS grants;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS key_grants;
DROP TABLE IF EXISTS vault_members;
DROP TABLE IF EXISTS key_scopes;
DROP TABLE IF EXISTS vaults;

DROP FUNCTION IF EXISTS next_vault_seq(BIGINT);
DROP FUNCTION IF EXISTS role_permission(TEXT);
DROP FUNCTION IF EXISTS permission_rank(TEXT);

-- Restores the plaintext definitions from 000001 so a rollback lands on the schema this
-- migration actually replaced.
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

CREATE UNIQUE INDEX IF NOT EXISTS folders_parent_name_key
    ON folders (vault_id, parent_id, name)
    WHERE parent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS folders_root_name_key
    ON folders (vault_id, name)
    WHERE parent_id IS NULL;

CREATE TRIGGER trg_folders_updated_at
    BEFORE UPDATE
    ON folders
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

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
