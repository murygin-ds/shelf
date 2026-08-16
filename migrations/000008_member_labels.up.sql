-- A private note one member keeps on a vault. Somebody else named the vaults you were let
-- into, and "Handbook" tells you less than "onboarding docs — ask Rita" would.
--
-- It hangs off the membership rather than the vault because nobody else may read it, which
-- is also why it is sealed to the member's own identity key instead of the shared scope
-- key: the server stores bytes it holds no key for, like everything else here.
ALTER TABLE vault_members
    ADD COLUMN IF NOT EXISTS label       BYTEA,
    ADD COLUMN IF NOT EXISTS label_nonce BYTEA;

-- Half a sealed box is unopenable, so the pair is written or cleared together.
ALTER TABLE vault_members
    ADD CONSTRAINT vault_members_label_paired
        CHECK ((label IS NULL) = (label_nonce IS NULL));

-- A short line of prose, sealed: 66 bytes of box overhead over at most a few hundred of
-- text. The cap is a sanity bound, not a budget the client is meant to spend.
ALTER TABLE vault_members
    ADD CONSTRAINT vault_members_label_length
        CHECK (label IS NULL OR octet_length(label) <= 1024);
