ALTER TABLE vaults
    DROP COLUMN IF EXISTS graph_reveals_locked;

DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS file_revisions;
DROP TABLE IF EXISTS note_links;
