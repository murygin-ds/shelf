ALTER TABLE vault_members
    DROP CONSTRAINT IF EXISTS vault_members_label_length;

ALTER TABLE vault_members
    DROP CONSTRAINT IF EXISTS vault_members_label_paired;

ALTER TABLE vault_members
    DROP COLUMN IF EXISTS label_nonce;

ALTER TABLE vault_members
    DROP COLUMN IF EXISTS label;
