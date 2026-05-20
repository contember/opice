-- Per-project read tokens + source-file backlinks.
--
-- v1 had a single global READ_TOKEN (an env var) gating the whole dashboard.
-- This adds an optional per-project read token so a single project's runs can
-- be shared via URL without exposing every other project. The global token
-- still works as a superuser ("see everything") for the dashboard owner.
--
-- The read token is stored in PLAINTEXT (unlike api_key_hash): it is read-only,
-- lower-sensitivity, and the dashboard detail page must be able to render the
-- shareable `?token=...` URL, which requires reading it back.
--
-- Existing rows get NULL — use the admin rotate endpoint to mint one.
ALTER TABLE projects ADD COLUMN read_token TEXT;
CREATE INDEX projects_read_token_idx ON projects(read_token);

-- Backlink each reported scenario to the source files that produced it, so the
-- re-eval workflow can jump from a failed scenario straight to its test +
-- human-readable scenario without grepping by name.
ALTER TABLE scenarios ADD COLUMN test_file TEXT;
ALTER TABLE scenarios ADD COLUMN scenario_file TEXT;
