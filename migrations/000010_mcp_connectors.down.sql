DROP TABLE IF EXISTS mcp_tokens;
DROP TABLE IF EXISTS oauth_codes;
DROP TABLE IF EXISTS oauth_clients;

-- The connector accounts go with the table that named them. Their memberships and key
-- grants follow through the cascade on users, which is the whole reason the connector was
-- made an account rather than a subject type of its own.
DELETE FROM users WHERE id IN (SELECT connector_user_id FROM vault_mcp);

DROP TABLE IF EXISTS vault_mcp;
