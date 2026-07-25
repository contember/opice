-- Scenario footprint + the change-tracking index.
--
-- A footprint records what a scenario touched in the browser: source files,
-- React components, API endpoints and GraphQL models (opt-in, OPICE_FOOTPRINT).
-- It is stored in TWO places, because it answers two different questions.
--
--  1. "What did THIS run's scenario touch?" — the full blob, in R2 under the
--     same `<slug>/<runId>/...` namespace as screenshots and videos, so the
--     existing key-scope checks guard it unchanged. `footprint_r2_key` points
--     at it; `footprint_summary` holds the counts a list view needs so the
--     dashboard needn't fetch the blob to badge a scenario.
--
--  2. "Which scenarios touch file X?" — `footprint_edges`, the queryable index
--     behind `opice test --impacted`. Note what it is NOT keyed on: the run. An
--     edge belongs to a SCENARIO (test file + name), and a newer run REPLACES
--     that scenario's edges rather than adding to them. That is what keeps the
--     index O(scenarios x files) forever instead of growing without bound —
--     a 50-scenario project stays around 10k rows whether it has run ten times
--     or ten thousand.
--
-- Only CI runs write edges. A local run happens against a half-built app on
-- someone's laptop, and letting it rewrite the shared index is the one way this
-- table could start selecting the wrong tests for everyone else.

ALTER TABLE scenarios ADD COLUMN footprint_r2_key TEXT;   -- R2 key of the full footprint blob; NULL when not collected
ALTER TABLE scenarios ADD COLUMN footprint_summary TEXT;  -- compact JSON counts (FootprintSummary)

CREATE TABLE footprint_edges (
	project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	-- `<test_file>::<name>` — the scenario's identity ACROSS runs. Two scenarios
	-- with the same name in different files stay distinct; a scenario that moves
	-- file gets a new key and its old edges age out on the next full run.
	scenario_key  TEXT NOT NULL,
	test_file     TEXT,
	scenario_name TEXT NOT NULL,
	kind          TEXT NOT NULL CHECK (kind IN ('file', 'component', 'endpoint', 'model')),
	value         TEXT NOT NULL,
	-- Fraction of the file V8 saw execute, x1000 (files only); NULL otherwise.
	weight        INTEGER,
	-- File edges: 1 when the scenario CALLED code in the file, 0 when it merely
	-- loaded it. Without this the file dimension saturates and stops selecting
	-- anything: measured on a real Contember admin, one navigation scenario
	-- "executed" ~1300 files at >50% of their bytes, because the app evaluates its
	-- schema and component library on import. Counting only what was called cuts
	-- that to ~200 and makes two scenarios distinguishable again. A footprint
	-- collected WITHOUT coverage has no way to tell the two apart, so its file
	-- edges are all recorded as exercised — the strongest claim its data supports.
	exercised     INTEGER NOT NULL DEFAULT 1,
	-- Model edges: 1 when reached through a mutation. A write is a far stronger
	-- impact signal than a read, and worth seeing on the dashboard as such.
	writes        INTEGER NOT NULL DEFAULT 0,
	run_id        TEXT,
	branch        TEXT,
	updated_at    INTEGER NOT NULL,
	PRIMARY KEY (project_id, scenario_key, kind, value)
);

-- The lookup `--impacted` runs: given a kind and a value, which scenarios?
CREATE INDEX footprint_edges_lookup ON footprint_edges(project_id, kind, value);
-- Replacing one scenario's edges wholesale on a new run.
CREATE INDEX footprint_edges_scenario ON footprint_edges(project_id, scenario_key);
