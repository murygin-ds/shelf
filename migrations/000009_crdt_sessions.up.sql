-- The live document behind a note.
--
-- Two people editing one note cannot be merged by this server: it holds ciphertext and no
-- key, so it can neither transform an operation nor compare two versions. The merge
-- therefore happens in the browsers, as a CRDT, and what lands here is a log of sealed
-- updates the server relays and stores without understanding any of it.
--
-- files.content stays the projection everything else reads — search, revisions, public
-- links, the offline cache and the delta feed — and is written back periodically by
-- whichever client the server named as the committer. Between commits the log is the truth
-- and the body lags; that is the price of a merge the server cannot perform.
--
-- One row per note, and that is what makes seeding unambiguous. Two clients opening a note
-- with no document both try to insert, exactly one wins, and the loser adopts the winner's
-- state instead of merging its own: two independently seeded documents have different
-- client identifiers, so merging them puts the text in twice.
CREATE TABLE IF NOT EXISTS file_crdt_docs
(
    file_id        BIGINT PRIMARY KEY REFERENCES files (id) ON DELETE CASCADE,
    vault_id       BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    key_scope_id   BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE CASCADE,
    key_version    INTEGER     NOT NULL,
    -- Raised whenever the body moves without the document knowing: an offline write
    -- replayed from the outbox, a client too old to speak the socket, a re-key. An update
    -- written against an older epoch describes a document that no longer exists, and
    -- merging it would apply an edit to text it was never written against.
    epoch          INTEGER     NOT NULL DEFAULT 1,
    -- The body version the log has been folded into. Equal to files.content_seq means the
    -- projection is current; behind it means a commit is owed.
    committed_seq  BIGINT      NOT NULL,
    -- The document state as of snapshot_seq, sealed like a body. A snapshot is not the
    -- text: it carries the CRDT's own structure, including the tombstones of deleted
    -- characters, which is why a document cannot be rebuilt from files.content alone.
    snapshot       BYTEA,
    snapshot_nonce BYTEA,
    -- Everything at or below this is covered by the snapshot and has been pruned.
    snapshot_seq   BIGINT      NOT NULL DEFAULT 0,
    -- The last sequence handed out, allocated under this row's lock. That lock is what
    -- keeps the log gap-free, the same way next_vault_seq keeps the sync cursor gap-free.
    last_seq       BIGINT      NOT NULL DEFAULT 0,
    -- What has piled up since the snapshot. The server cannot merge ciphertext, so this is
    -- the only bound on growth it can enforce without reading anything.
    pending_count  INTEGER     NOT NULL DEFAULT 0,
    pending_bytes  BIGINT      NOT NULL DEFAULT 0,
    created_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (epoch > 0),
    -- Twice the body ceiling: a document carries the tombstones of everything ever deleted
    -- from it, so it is legitimately larger than the text it produces.
    CHECK (snapshot IS NULL OR octet_length(snapshot) <= 8388608),
    CHECK ((snapshot IS NULL) = (snapshot_nonce IS NULL))
);

CREATE INDEX IF NOT EXISTS file_crdt_docs_vault_idx ON file_crdt_docs (vault_id);

CREATE TRIGGER trg_file_crdt_docs_updated_at
    BEFORE UPDATE
    ON file_crdt_docs
    FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- One batch of merged CRDT updates, sealed under the note's scope key.
--
-- Signed for the same reason a revision is: view, comment and edit are one key, so without
-- a signature a reader could inject text that decrypts for everybody and no reader could
-- tell it from the author's. Refusing an update from a reader on the socket is the first
-- line; this is the one that holds even if the server is the one lying.
--
-- The server checks the signature's length and nothing else. It holds no public key it was
-- not handed, and verifying is the readers' job.
CREATE TABLE IF NOT EXISTS file_crdt_updates
(
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id          BIGINT      NOT NULL REFERENCES files (id) ON DELETE CASCADE,
    vault_id         BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    key_scope_id     BIGINT      NOT NULL REFERENCES key_scopes (id) ON DELETE CASCADE,
    key_version      INTEGER     NOT NULL,
    epoch            INTEGER     NOT NULL,
    seq              BIGINT      NOT NULL,
    payload          BYTEA       NOT NULL,
    nonce            BYTEA       NOT NULL,
    author_id        BIGINT REFERENCES users (id) ON DELETE SET NULL,
    -- Raw ECDSA P-256 signature (r||s), like file_revisions.author_signature. Nullable so
    -- an update from an older client is visibly unsigned rather than silently trusted.
    author_signature BYTEA,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Updates are batched client-side into frames of a few hundred bytes; this is the
    -- ceiling for a resynchronising client that sends its whole state as one update.
    CHECK (octet_length(payload) <= 262144),
    CHECK (author_signature IS NULL OR octet_length(author_signature) = 64),
    -- A retried send cannot fork the log, the same way UNIQUE (file_id, content_seq) keeps
    -- the revision history from forking.
    UNIQUE (file_id, epoch, seq)
);

CREATE INDEX IF NOT EXISTS file_crdt_updates_stream_idx ON file_crdt_updates (file_id, epoch, seq);
CREATE INDEX IF NOT EXISTS file_crdt_updates_vault_idx ON file_crdt_updates (vault_id);
