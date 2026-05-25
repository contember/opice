-- "fixme" steps: a step the author marked as a known, tolerated failure via
-- step.fixme(name, reason, fn). It runs like any other step, but its failure
-- must NOT fail the scenario or the run — it surfaces as an amber warning.
--
-- Two new step statuses:
--   'fixme'     — marked fixme, and failed (as expected)
--   'fixmepass' — marked fixme, but unexpectedly passed (stale marker)
--
-- Scenario/run "warning" stays a *computed* display status (like 'incomplete'):
-- we leave the runs/scenarios CHECKs alone and derive warning at read time from
-- these step statuses. Only the raw step status genuinely needs new values.
--
-- SQLite can't widen a CHECK in place, so rebuild the steps table. Nothing has
-- a foreign key INTO steps, so this is a plain copy. Also add `reason`, the
-- mandatory human note from step.fixme.

CREATE TABLE steps_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	name TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'fixme', 'fixmepass')),
	duration_ms INTEGER NOT NULL,
	error TEXT,
	reason TEXT,
	screenshot_r2_key TEXT,
	created_at INTEGER NOT NULL
);

INSERT INTO steps_new (id, scenario_id, sequence, name, status, duration_ms, error, screenshot_r2_key, created_at)
	SELECT id, scenario_id, sequence, name, status, duration_ms, error, screenshot_r2_key, created_at FROM steps;

DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE INDEX steps_scenario_idx ON steps(scenario_id, sequence);
