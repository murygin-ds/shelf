-- Purge leaves no row behind, so a client that was offline at the time would keep the
-- node forever. A tombstone carries the fact of the deletion on the same change sequence
-- every other update rides, which is what lets a delta sync stay authoritative.
--
-- Soft deletes need nothing here: the row survives with deleted_at set and travels as an
-- ordinary update.
CREATE TABLE IF NOT EXISTS purged_entities
(
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vault_id    BIGINT      NOT NULL REFERENCES vaults (id) ON DELETE CASCADE,
    entity_type TEXT        NOT NULL,
    entity_id   BIGINT      NOT NULL,
    purged_seq  BIGINT      NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (entity_type IN ('folder', 'file'))
);

CREATE INDEX IF NOT EXISTS purged_entities_vault_seq_idx ON purged_entities (vault_id, purged_seq);
CREATE UNIQUE INDEX IF NOT EXISTS purged_entities_ref_key ON purged_entities (entity_type, entity_id);
