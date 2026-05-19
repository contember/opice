-- Opice reporting platform — initial schema.
--
-- Single-tenant v1: one set of projects owned by the operator. Auth is a
-- per-project API key (sha256-hashed at rest).

CREATE TABLE projects (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT UNIQUE NOT NULL,
	name TEXT NOT NULL,
	api_key_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	branch TEXT,
	commit_sha TEXT,
	status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
	total_scenarios INTEGER NOT NULL DEFAULT 0,
	passed_scenarios INTEGER NOT NULL DEFAULT 0,
	failed_scenarios INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL,
	finished_at INTEGER
);

CREATE INDEX runs_project_started_idx ON runs(project_id, started_at DESC);

CREATE TABLE scenarios (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	hash TEXT,
	status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
	duration_ms INTEGER,
	started_at INTEGER NOT NULL,
	finished_at INTEGER
);

CREATE INDEX scenarios_run_idx ON scenarios(run_id, started_at);

CREATE TABLE steps (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
	duration_ms INTEGER NOT NULL,
	error TEXT,
	screenshot_r2_key TEXT,
	created_at INTEGER NOT NULL
);

CREATE INDEX steps_scenario_idx ON steps(scenario_id, sequence);
