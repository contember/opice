-- A step's screenshot upload to R2 can fail independently of the step itself —
-- R2 occasionally answers `put` with a transient internal error (code 10001),
-- and the step row is already written by then. Rather than 500 the whole step
-- ingest (which strict reporting would turn into a failed CI run), the upload is
-- best-effort: on failure the step is kept and this flag is set, so the gap
-- between "no screenshot captured" (key NULL, flag 0) and "screenshot captured
-- but upload failed" (key NULL, flag 1) is visible on the dashboard.
ALTER TABLE steps ADD COLUMN screenshot_failed INTEGER NOT NULL DEFAULT 0;
