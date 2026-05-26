-- Retry support. A scenario may run more than once when the test runner is
-- configured with retries (bun `--retry`, or per-test `{ retry }`): a flaky
-- scenario that fails then passes is reported as passed but flagged flaky.
--
-- `steps.attempt` tags each step with the 0-based attempt that produced it, so
-- reads can show only the final attempt's steps (earlier attempts are kept for
-- forensics but not displayed). `scenarios.attempts` records how many attempts
-- the scenario took in total — a passed scenario with attempts > 1 is "flaky".
ALTER TABLE steps ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scenarios ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
