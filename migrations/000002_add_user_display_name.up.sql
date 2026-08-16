-- Human-readable name shown in avatars, the member table and the sidebar footer.
-- Plaintext by necessity: the login is already an address the server has to index, and
-- every member of a shared vault sees the name, so encrypting it would mean storing one
-- copy wrapped per viewer. It belongs to the metadata the server knowingly learns.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';

ALTER TABLE users
    ADD CONSTRAINT users_display_name_length CHECK (char_length(display_name) <= 128);
