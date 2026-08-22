-- The MCP connector: the one place where this server is given a key.
--
-- Everywhere else the rule holds that the server stores bytes it cannot open. A connector
-- is the deliberate exception, and it is worth stating plainly what it costs. Claude
-- reaches a vault over HTTPS, which means something on this side has to turn ciphertext
-- into text; there is no arrangement in which a remote assistant reads a vault and the
-- server does not. What the exception buys is that it is an exception: it covers one vault
-- at a time, only after its owner asked for it, and it is undone by removing a member.
--
-- The connector is not a new kind of subject. It is an account, with the same two-part
-- identity blob a person carries, admitted to one vault as a member. That is what makes it
-- cheap: the scope key reaches it through an ordinary key grant, rotation carries it along
-- because rekey_subjects already looks for grant holders in users, revoking it is the
-- member removal that was written years before this table, and denying it a folder is the
-- same permission row that denies a person one. A subject type of its own would have had
-- to re-earn each of those, and the rotation commit would have deleted its grant on the
-- first routine re-key.
--
-- What it costs in exchange: the connector shows up in the member list and in member_count,
-- and the vault scope now has two key holders rather than one. Both are true statements
-- about the vault, so they are shown rather than hidden.
CREATE TABLE IF NOT EXISTS vault_mcp
(
    vault_id          BIGINT PRIMARY KEY REFERENCES vaults (id) ON DELETE CASCADE,
    connector_user_id BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- The fingerprint of the identity in force when this was enabled. A server whose key
    -- changed has to be noticed rather than silently failing to decrypt.
    identity_fpr      TEXT        NOT NULL,
    enabled_by        BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A connector is a membership. Saying so here rather than in code is what makes turning
    -- one off the same act as removing any other member: the existing removal deletes the
    -- membership, and this row goes with it. Without the cascade, disabling would be two
    -- transactions that can disagree, and the pair that disagreed would be unrecoverable.
    FOREIGN KEY (vault_id, connector_user_id)
        REFERENCES vault_members (vault_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS vault_mcp_connector_key ON vault_mcp (connector_user_id);

-- OAuth clients, registered dynamically.
--
-- Claude registers itself on a fresh connection rather than being configured in advance,
-- so this table is written by strangers and is expected to accumulate rows. They are public
-- clients: there is no secret to store, and PKCE is what stands in for one.
CREATE TABLE IF NOT EXISTS oauth_clients
(
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id     TEXT        NOT NULL,
    client_name   TEXT        NOT NULL DEFAULT '',
    redirect_uris TEXT[]      NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (cardinality(redirect_uris) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_clients_client_id_key ON oauth_clients (client_id);
CREATE INDEX IF NOT EXISTS oauth_clients_last_used_at_idx ON oauth_clients (last_used_at);

-- Authorization codes: short-lived, single-use, stored only as a digest.
--
-- consumed_at rather than a delete, because a code presented twice is not a mistake to
-- shrug off — it means the code leaked, and the tokens it produced should go with it.
CREATE TABLE IF NOT EXISTS oauth_codes
(
    code_hash      BYTEA PRIMARY KEY,
    client_id      BIGINT      NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
    vault_id       BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    user_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    redirect_uri   TEXT        NOT NULL,
    -- S256 only: what is stored is the challenge, never the verifier.
    code_challenge TEXT        NOT NULL,
    scope          TEXT        NOT NULL DEFAULT '',
    expires_at     TIMESTAMPTZ NOT NULL,
    consumed_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_codes_expires_at_idx ON oauth_codes (expires_at);

-- Tokens issued to a connector, kept apart from the browser's sessions table on purpose.
--
-- Rotation there is single-use and a replay revokes every session the account has; letting
-- Claude and a browser tab pull on the same token would eventually log somebody out of
-- their own vault to punish a race neither of them lost. Here a replay burns one chain.
--
-- The static kind exists for the local case: Claude Code reaches a server on localhost and
-- can carry a fixed header, which is what makes the connector testable before it is exposed
-- to the internet at all.
CREATE TABLE IF NOT EXISTS mcp_tokens
(
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id     BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    user_id      BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    client_id    BIGINT REFERENCES oauth_clients (id) ON DELETE CASCADE,
    kind         TEXT        NOT NULL,
    token_hash   BYTEA       NOT NULL,
    label        TEXT        NOT NULL DEFAULT '',
    -- Rotation chain: presenting a refresh token that was already spent kills the chain it
    -- belonged to, and nothing else.
    chain_id     BIGINT,
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (kind IN ('static', 'access', 'refresh'))
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_tokens_hash_key ON mcp_tokens (token_hash);
CREATE INDEX IF NOT EXISTS mcp_tokens_vault_idx ON mcp_tokens (vault_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_chain_idx ON mcp_tokens (chain_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_expires_at_idx ON mcp_tokens (expires_at);
