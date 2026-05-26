-- Two-phase authoring: pending steps, step kind/intent, scenario metadata.
--
-- Phase-1 skeletons (written by opice-plan) report steps with status 'pending':
-- declared, with an `intent`, but not yet authored — the body never ran. A
-- scenario carrying a pending step (and no hard failure) reads as 'incomplete'
-- — computed at read time, exactly like 'warning' (never stored). Steps also
-- gain `kind` ('step' | 'invariant', an invariant being a scenario-level
-- acceptance) and the durable `intent` carried from the test's step contract.
-- Scenarios gain the browserTest() metadata: `feature`, `seeds`, `roles`.

-- steps: widen the status CHECK to include 'pending' and add kind/intent.
-- SQLite can't alter a CHECK in place, so rebuild (nothing FKs into steps).
CREATE TABLE steps_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	kind TEXT NOT NULL DEFAULT 'step' CHECK (kind IN ('step', 'invariant')),
	name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'fixme', 'fixmepass', 'pending')),
	duration_ms INTEGER NOT NULL,
	error TEXT,
	intent TEXT,
	reason TEXT,
	screenshot_r2_key TEXT,
	created_at INTEGER NOT NULL
);

INSERT INTO steps_new (id, scenario_id, sequence, name, status, duration_ms, error, reason, screenshot_r2_key, created_at)
	SELECT id, scenario_id, sequence, name, status, duration_ms, error, reason, screenshot_r2_key, created_at FROM steps;

DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE INDEX steps_scenario_idx ON steps(scenario_id, sequence);

-- scenarios: browserTest() metadata. seeds/roles are stored as JSON arrays
-- (TEXT); db.ts parses them back to string[] on read.
ALTER TABLE scenarios ADD COLUMN feature TEXT;
ALTER TABLE scenarios ADD COLUMN seeds TEXT;
ALTER TABLE scenarios ADD COLUMN roles TEXT;
