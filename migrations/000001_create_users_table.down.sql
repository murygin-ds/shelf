-- The order matters: dependent tables are dropped before users
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS vaults;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS recovery_keys;
DROP TABLE IF EXISTS users;

DROP FUNCTION IF EXISTS set_updated_at();
