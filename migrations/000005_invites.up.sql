-- Invites into a vault.
--
-- One table serves both paths. A code invite stores only the hash of a code that never
-- reaches the server, and the scope keys sealed under a key derived from that same code.
-- A direct invite names an account that already exists, so its keys are sealed straight to
-- that account's public key and no secret is needed at all.
--
-- The preview — the vault name and who is inviting — is encrypted too: an unauthenticated
-- lookup by code must not turn the server into a directory of vault names.
CREATE TABLE IF NOT EXISTS invites
(
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id        BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    token_hash      BYTEA,
    target_user_id  BIGINT REFERENCES users (id) ON DELETE CASCADE,
    email_hint      TEXT,
    role            TEXT        NOT NULL,
    wrapped_preview BYTEA,
    preview_nonce   BYTEA,
    invited_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    redeemed_at     TIMESTAMPTZ,
    redeemed_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- An owner cannot be invited: a vault has exactly one, and it is the account that
    -- created it.
    CHECK (role IN ('admin', 'editor', 'viewer')),
    -- Exactly one of the two paths, never both and never neither.
    CHECK ((token_hash IS NULL) <> (target_user_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS invites_token_hash_key ON invites (token_hash) WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS invites_vault_id_idx ON invites (vault_id);
CREATE INDEX IF NOT EXISTS invites_target_idx ON invites (target_user_id) WHERE redeemed_at IS NULL;
