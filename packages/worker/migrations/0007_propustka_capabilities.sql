-- Auth model: everything moves onto propustka.
--
-- The app-local `tokens` table (unified machine + share credentials, migration 0003)
-- is GONE. There are no opice-owned credentials anymore — every non-operator caller
-- is a propustka CAPABILITY TOKEN, and operators are Cloudflare Access + propustka.
-- This drops every existing ingest/read/share token: CI reporters + share links must
-- be re-provisioned with capability tokens (mint at project create / from the run page).
DROP TABLE IF EXISTS tokens;

-- A thin local MIRROR of the propustka capability tokens opice has issued. The secret
-- (and the authoritative validity: expiry / maxUses / revocation) lives in propustka —
-- this table only records metadata so the dashboard can list + revoke (the propustka
-- contract has issue/redeem/revoke but no "list my capabilities"). `id` is the
-- capability token id returned by issueCapability; revoking flips revoked_at here AND
-- calls revokeCapability so the token stops redeeming centrally.
--
--   kind = 'ingest' → the project write DSN (OPICE_DSN; grant report.write on project:<slug>)
--   kind = 'read'   → the project read DSN (OPICE_READ_DSN / self-test; report.read+project.read on project:<slug>)
--   kind = 'share'  → a per-run read share link (report.read on run:<id> + project.read on project:<slug>)
CREATE TABLE capabilities (
	id          TEXT PRIMARY KEY,
	project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	run_id      TEXT    REFERENCES runs(id) ON DELETE CASCADE,
	kind        TEXT    NOT NULL CHECK (kind IN ('ingest', 'read', 'share')),
	label       TEXT,
	created_by  TEXT,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER,
	revoked_at  INTEGER
);

CREATE INDEX capabilities_project_idx ON capabilities(project_id);
CREATE INDEX capabilities_run_idx ON capabilities(run_id);
