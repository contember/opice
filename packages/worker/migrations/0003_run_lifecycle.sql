-- Run lifecycle: tell CI runs apart from local ones, track activity so a
-- reaper can finalize abandoned runs, and let a run read as 'incomplete'.
--
-- 'incomplete' is a *computed* display status backed by the reaped_at flag —
-- we deliberately don't widen the runs.status CHECK (that would mean rebuilding
-- the table, which scenarios reference via FK). The stored status stays one of
-- running/passed/failed; the DTO maps a reaped or stale run to 'incomplete'.

ALTER TABLE runs ADD COLUMN source TEXT;            -- 'ci' | 'local' | NULL (legacy)
ALTER TABLE runs ADD COLUMN last_activity_at INTEGER; -- bumped on every ingest write
ALTER TABLE runs ADD COLUMN reaped_at INTEGER;      -- set when the reaper gives up on a stale run

-- The reaper sweeps running runs by staleness.
CREATE INDEX runs_status_activity_idx ON runs(status, last_activity_at);
