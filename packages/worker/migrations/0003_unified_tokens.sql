-- Unified credential model.
--
-- v1/v2 grew four parallel auth mechanisms: per-project api keys (write), a
-- global READ_TOKEN env, per-project plaintext read tokens, and an ADMIN_TOKEN
-- env. This collapses every *machine* and *share* credential into one table.
-- Human auth (email+password sessions, roles) stays in BetterAuth's AUTH_DB.
--
-- A token row carries a capability and a scope:
--   capability  read | write | admin
--   scope       project_id NULL              -> all projects
--               project_id set, run_id NULL  -> the whole project
--               project_id + run_id set       -> a single run (share links)
--
-- The secret is never stored: only its sha256 (token_hash), the same scheme the
-- old api_key_hash used. The id is a public handle for listing/revoking.
CREATE TABLE tokens (
	id          TEXT PRIMARY KEY,
	token_hash  TEXT NOT NULL UNIQUE,
	capability  TEXT NOT NULL CHECK (capability IN ('read', 'write', 'admin')),
	project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
	run_id      TEXT    REFERENCES runs(id)     ON DELETE CASCADE,
	label       TEXT,
	created_by  TEXT,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER,
	last_used_at INTEGER,
	revoked_at  INTEGER
);

CREATE INDEX tokens_hash_idx ON tokens(token_hash);
CREATE INDEX tokens_project_idx ON tokens(project_id);

-- Backfill: each project's existing API key becomes a project-scoped write
-- token. api_key_hash is already sha256(key) — exactly what the resolver looks
-- up — so existing OPICE_DSN keys keep working untouched.
INSERT INTO tokens (id, token_hash, capability, project_id, label, created_by, created_at)
SELECT lower(hex(randomblob(16))), api_key_hash, 'write', id, 'ingest (migrated)', 'backfill', created_at
FROM projects;

-- Drop the now-unified project columns. Per-project read tokens are gone;
-- sharing is now per-run read tokens minted on demand (no BC — any previously
-- shared ?token= links stop working, re-share from the run page).
DROP INDEX IF EXISTS projects_read_token_idx;
ALTER TABLE projects DROP COLUMN read_token;
ALTER TABLE projects DROP COLUMN api_key_hash;
