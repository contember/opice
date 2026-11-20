-- The reporting schema. Times are integer milliseconds since the epoch, as the reporter and the previous platform
-- wrote them. A run lies in a project; its scenarios, steps and share links are child rows of the run. A step names
-- its scenario by `scenario_id` within the same run (the handlers check it), so the steps of a run are one child table.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	created_by TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	branch TEXT,
	commit_sha TEXT,
	status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
	source TEXT CHECK (source IN ('ci', 'local')),
	tier TEXT,
	total_scenarios INTEGER NOT NULL DEFAULT 0,
	passed_scenarios INTEGER NOT NULL DEFAULT 0,
	failed_scenarios INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL,
	last_activity_at INTEGER,
	reaped_at INTEGER,
	finished_at INTEGER,
	UNIQUE (id, project_id)
) STRICT;
CREATE INDEX runs_project_started ON runs (project_id, started_at);
CREATE INDEX runs_started ON runs (started_at);
CREATE INDEX runs_status_activity ON runs (status, last_activity_at);

CREATE TABLE scenarios (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	name TEXT NOT NULL,
	hash TEXT,
	test_file TEXT,
	scenario_file TEXT,
	feature TEXT,
	seeds TEXT,
	roles TEXT,
	tier TEXT,
	status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
	duration_ms INTEGER,
	attempts INTEGER NOT NULL DEFAULT 1,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	skipped_at INTEGER,
	skip_reason TEXT,
	FOREIGN KEY (run_id, project_id) REFERENCES runs (id, project_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE INDEX scenarios_run ON scenarios (run_id, started_at);

CREATE TABLE steps (
	id TEXT PRIMARY KEY NOT NULL,
	run_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	scenario_id TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	sequence INTEGER NOT NULL,
	kind TEXT NOT NULL DEFAULT 'step' CHECK (kind IN ('step', 'invariant')),
	name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'fixme', 'fixmepass', 'pending')),
	duration_ms INTEGER NOT NULL,
	error TEXT,
	intent TEXT,
	manual TEXT,
	reason TEXT,
	screenshot TEXT REFERENCES fabrika_files (id),
	screenshot_failed BOOLEAN NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	FOREIGN KEY (run_id, project_id) REFERENCES runs (id, project_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX steps_scenario ON steps (scenario_id, attempt, sequence);
CREATE INDEX steps_run ON steps (run_id);
CREATE INDEX steps_screenshot ON steps (screenshot);

CREATE TABLE run_shares (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	project_id TEXT NOT NULL,
	link_id TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	revoked_at INTEGER,
	FOREIGN KEY (run_id, project_id) REFERENCES runs (id, project_id) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT;
CREATE INDEX run_shares_run ON run_shares (run_id);
