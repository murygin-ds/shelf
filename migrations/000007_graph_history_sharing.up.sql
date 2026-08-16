-- Links between notes.
--
-- A [[wikilink]] is written as a title, and titles are encrypted: only the reader who holds
-- the key can resolve one to a note. So this table holds nothing but the pair of ids that
-- some reader already resolved, and it is a shared advisory artifact rather than a truth
-- the server can verify. Two readers with different access will disagree about what links
-- exist, and both are right about their own slice.
--
-- A link the writer could not resolve never reaches the server at all: sending it would
-- publish the unmatched title.
CREATE TABLE IF NOT EXISTS note_links
(
    vault_id     BIGINT NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    from_file_id BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    to_file_id   BIGINT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (from_file_id, to_file_id),
    -- A note linking to itself carries no information and would draw a loop in the graph.
    CHECK (from_file_id <> to_file_id)
);

CREATE INDEX IF NOT EXISTS note_links_backlinks_idx ON note_links (to_file_id);
CREATE INDEX IF NOT EXISTS note_links_vault_idx ON note_links (vault_id);

-- The history of a note's body.
--
-- Every revision carries the author's signature over the ciphertext it stores. Without it,
-- "who wrote this" would be whatever the server says: view, comment and edit are the same
-- key, so any reader can produce ciphertext that decrypts, and no reader could tell.
-- The signature is made with the account's ECDSA key, which the server never holds.
--
-- The key scope and version are stored per revision because a re-key rewrites the current
-- row but leaves history under the version it was written with — dropping that would make
-- every revision before the first rotation unreadable.
CREATE TABLE IF NOT EXISTS file_revisions
(
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id          BIGINT      NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    vault_id         BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    key_scope_id     BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE CASCADE,
    key_version      INTEGER     NOT NULL,
    content          BYTEA       NOT NULL,
    content_nonce    BYTEA       NOT NULL,
    content_seq      BIGINT      NOT NULL,
    author_id        BIGINT REFERENCES users (id) ON DELETE SET NULL,
    -- Raw ECDSA P-256 signature (r||s), 64 bytes, over the digest of the slot and its
    -- ciphertext. Nullable so a revision written by an older client is visibly unsigned
    -- rather than silently trusted.
    author_signature BYTEA,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (octet_length(content) <= 4194304),
    CHECK (author_signature IS NULL OR octet_length(author_signature) = 64),
    -- One revision per version of a note, so a retried write cannot fork the history.
    UNIQUE (file_id, content_seq)
);

CREATE INDEX IF NOT EXISTS file_revisions_file_idx ON file_revisions (file_id, content_seq DESC);

-- Read-only links to a single note.
--
-- The link carries its own copy of the note, encrypted under a key derived from a secret
-- the server never sees. It does NOT carry the note's scope key: a scope covers a whole
-- folder or a whole vault, so handing that out would make one published note the key to
-- everything sealed beside it, and revoking the link would not take it back.
--
-- The copy is a snapshot of the version that was published. That is a deliberate
-- narrowing: a live public link would silently publish every future edit, and there is no
-- way to un-publish an edit that has already been served.
--
-- Read-only is not a setting that could be relaxed later: an anonymous writer holds no
-- signing key, and an unsigned revision is what author signatures exist to rule out.
CREATE TABLE IF NOT EXISTS share_links
(
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id        BIGINT      NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    vault_id       BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    token_hash     BYTEA       NOT NULL,
    meta           BYTEA       NOT NULL,
    meta_nonce     BYTEA       NOT NULL,
    content        BYTEA       NOT NULL,
    content_nonce  BYTEA       NOT NULL,
    -- Which version was published, so the owner can see whether the link has fallen behind.
    content_seq    BIGINT      NOT NULL,
    permission     TEXT        NOT NULL DEFAULT 'view',
    created_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    expires_at     TIMESTAMPTZ,
    revoked_at     TIMESTAMPTZ,
    last_viewed_at TIMESTAMPTZ,
    view_count     BIGINT      NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (permission = 'view'),
    CHECK (octet_length(content) <= 4194304)
);

CREATE UNIQUE INDEX IF NOT EXISTS share_links_token_hash_key ON share_links (token_hash);
CREATE INDEX IF NOT EXISTS share_links_file_idx ON share_links (file_id);
CREATE INDEX IF NOT EXISTS share_links_vault_idx ON share_links (vault_id);

-- The graph gives away the shape of a vault: how many notes there are and which of them
-- reference each other, including nodes the reader cannot open. That is deliberate — the
-- masked nodes are what make the graph honest — but a team that would rather not publish
-- its shape internally can turn it off.
ALTER TABLE vaults
    ADD COLUMN IF NOT EXISTS graph_reveals_locked BOOLEAN NOT NULL DEFAULT TRUE;
