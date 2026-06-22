-- Per-scenario walkthrough video (opt-in, OPICE_VIDEO). Where step screenshots
-- are per-step PNGs, a video is one webm covering the whole scenario walkthrough
-- — recorded by Playwright, streamed to R2 by the reporter after the scenario's
-- browser context closes. Stored in the SAME bucket as screenshots, keyed under
-- the `<slug>/<runId>/...` namespace so the existing R2-key scope checks apply
-- unchanged. Null when video was off (the default) or the upload failed
-- (best-effort, like a screenshot — it never reds the run).
ALTER TABLE scenarios ADD COLUMN video_r2_key TEXT;
