-- Human-readable manual line per step. Where `intent` is the machine-facing
-- spec, `manual` is the plain-language, stupid-simple instruction for a
-- non-technical reader (target language, formal register) — the structured
-- replacement for the `// MANUÁL:` comment that used to sit above a step.
--
-- Carried from the step's contract through the reporter and ingest. Stored
-- now; not yet surfaced on the dashboard (display lands later).
ALTER TABLE steps ADD COLUMN manual TEXT;
