-- Run-share mirror.
--
-- Run-share links moved off app-local read-token rows onto propustka CAPABILITY
-- tokens (issued / redeemed / revoked over the IAM service binding). The propustka
-- contract exposes issue/redeem/revoke but no "list my capabilities", so opice keeps
-- this thin local mirror to power the run page's share manager (list + revoke).
--
-- `id` is the capability token id returned by issueCapability (NOT the plaintext
-- token — that is shown once and never stored). Revoking a share flips revoked_at
-- here AND calls revokeCapability so the token stops redeeming centrally.
--
-- The old per-run read-token rows in `tokens` are now ignored on the data plane
-- (the resolver rejects any token with run_id set), so previously shared ?token=
-- links stop working — re-share from the run page. The data-plane `tokens` table is
-- now exclusively project/global read + write machine credentials (ingest / agent
-- read / self-test), never shares, never admin.
CREATE TABLE shares (
	id          TEXT PRIMARY KEY,
	run_id      TEXT    NOT NULL REFERENCES runs(id)     ON DELETE CASCADE,
	project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	label       TEXT,
	created_by  TEXT,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER,
	revoked_at  INTEGER
);

CREATE INDEX shares_run_idx ON shares(run_id);
