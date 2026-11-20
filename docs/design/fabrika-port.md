# Opice on fabrika

The platform (ingest, dashboard RPC, share links, the stale-run reaper) moves from the hand-written Worker in
`packages/worker` onto a fabrika contract application in `fabrika/`. It runs on Cloudflare in one Durable Object over
SQLite. `packages/worker` keeps serving the old host until the reporters move and is deleted afterwards.

`fabrika/` is its own package with its own `bun.lock`, outside the root workspaces: fabrika's Control deploys an
application from a directory that installs on its own.

## Authorization

| Plane             | Before (`packages/worker`)                          | After (`fabrika/`)                                                      |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| operator (human)  | Cloudflare Access + propustka `authenticate()`      | fabrika IAM session; the proxy enforces each endpoint's access form     |
| machine (CI)      | Access service token (`CF-Access-Client-*`)         | IAM service key (`px_…`) with grants in scope `project=<id>`            |
| anonymous share   | propustka capability token (`?token=`, cookie)      | a link of the `/s` link mount, bound to one run                         |
| credential minting | dashboard mints and revokes DSNs                   | an installation administrator, in the console (Access → Credentials)    |

Vocabulary `opice`: dimensions `project` (top level, `creator: 'owner'`) and `run` (in `project`). Actions
`project.read`, `project.write`, `report.read`, `report.write`, `data.import`. Roles: `viewer` (`project.read`,
`report.read`) and `editor` (all four but `data.import`) are application-wide; `owner` (all four but `data.import`) is
the creator's membership role in one project. No role grants `data.import`: only the import key holds it.

A CI key holds `report.write` (and `report.read` for `opice failures`) in its project. A key in one project reaches no
other: every machine procedure names its run or project, and the access form checks the chain.

## Data

SQLite migrations replay D1 migrations 0001–0011 as one schema. Times stay integer milliseconds.

- `projects` (dimension `project`): `slug` unique, `name`, `created_at`.
- `runs` (dimension `run` in `project`): the D1 columns.
- `scenarios` (child of `runs`): the D1 columns but the video key.
- `steps` (child of `runs`, a child table hangs under a dimension table): the D1 columns, plus `scenario_id`, which the
  handlers check against the run; `screenshot` is a file column (kind `screenshots`, PNG, at most 2 MiB).
- `run_shares` (child of `runs`): the IAM link id, who issued it, expiry, revocation. It replaces the `capabilities`
  mirror; ingest and read keys are not mirrored (IAM lists them).

## Surface

- `/api` (human): `session.me`, `projects.list|get|create`, `runs.listForProject|listAll|get|scenarios|steps|screenshot`
  (the screenshot is a GET file), `shares.create|list|revoke`.
- `/machine` (machine): `reports.startRun|startScenario|finishScenario|step|finishRun` (a skipped scenario is
  `startScenario` with `skipped: true`), `reads.run|scenarios|steps|screenshot`, `migration.*` (the one-off import,
  removed after the data move).
- `/s` (link mount on `run`): `run`, `scenarios`, `steps`, `screenshot`, and the share SPA.
- `/` the operator SPA (member). `/healthz`.
- Job `reapStaleRuns` every 5 minutes.

The reporter's DSN becomes `https://<px_key>@<host>/<projectId>`. A step's screenshot is a multipart file field of
`reports.step`.

## Not carried over

- Walkthrough videos: the framework's file store does not admit WebM yet; the harness keeps them on disk.
- Minting, rotating and listing DSNs in the dashboard (the console does it).
- Project-wide share links (only run links were ever issued).
- `GET /install.md`: the onboarding guide moves into the repository's docs.
