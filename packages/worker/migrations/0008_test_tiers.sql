-- Test tiers + skipped scenarios.
--
-- A scenario declares a `tier` (browserTest meta; critical < standard <
-- extended); a run records the `tier` it SELECTED (OPICE_TIER / `opice test
-- --tier`). Scenarios above the selected tier don't run — they're reported
-- 'skipped' so the dashboard shows the full inventory, not just what executed.
--
-- 'skipped' is a *computed* display status backed by the `skipped_at` flag — we
-- deliberately don't widen the scenarios.status CHECK (that would mean
-- rebuilding the table, which steps reference via FK), mirroring how runs map a
-- reaped/stale run to 'incomplete' via reaped_at (migration 0003). A skipped
-- scenario keeps its stored status but carries skipped_at + skip_reason; db.ts
-- maps it to 'skipped' on read and excludes it from the executed totals.

ALTER TABLE scenarios ADD COLUMN tier TEXT;          -- declared tier (critical|standard|extended); NULL = legacy / standard
ALTER TABLE scenarios ADD COLUMN skipped_at INTEGER;  -- set when the scenario was skipped (never ran)
ALTER TABLE scenarios ADD COLUMN skip_reason TEXT;    -- why (e.g. "tier 'extended' above the selected tier 'critical'")

ALTER TABLE runs ADD COLUMN tier TEXT;                -- the tier this run SELECTED (NULL = no filter / ran everything)
