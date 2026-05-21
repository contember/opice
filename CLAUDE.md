# CLAUDE.md

Opice is an AI-driven E2E browser test harness. The pipeline: human-readable `*.scenario.md` → LLM-generated `*.test.ts` (authored locally via a Claude Code skill) → deterministic CI runs (no LLM in the loop) → centralized reporting on a Cloudflare platform.

Two distinct things share the name "opice":
- **The product** the test author uses — `@opice/harness` (test runtime) + `@opice/cli` (`opice` binary) + the Claude Code skills, dropped into *their* repo.
- **This platform repo** — the Cloudflare Worker + D1 + R2 + dashboard SPA that ingests and displays runs.

Tests live in the *user's* repo, not here. The browser runs in *their* CI (driven by the `agent-browser` CLI). This repo only stores and displays results. See `README.md` for the design rationale and locked-in non-goals (no visual regression, no multi-tenant, no AI in CI, no browser farm).

## Commands

Bun is the runtime and package manager. Workspaces: `packages/*` and `apps/*`.

```bash
bun install
bun run typecheck          # tsc --build across the repo
bun test                   # runs apps/self-test (real browser against stage)

# Boot the platform locally (worker :18181, dashboard vite :18182); or `okena`:
bun --filter @opice/worker run db:migrate:local
bun --filter @opice/worker run db:migrate:auth:local
bun --filter @opice/worker run dev
bun --filter @opice/dashboard run dev

# Run a single harness test file (user's repo, or apps/self-test here):
bun test path/to/x.test.ts
bun test -t "scenario name substring"
```

## Packages
- `packages/harness/` — test-author runtime (npm). See below.
- `packages/cli/` — the `opice` binary. See below.
- `packages/worker/` — CF Worker + D1×2 + R2 ingest/RPC/auth backend. **Read `packages/worker/CLAUDE.md`** before editing.
- `packages/dashboard/` — React 19 SPA. **Read `packages/dashboard/CLAUDE.md`** before editing.
- `apps/self-test/` — dogfood smoke test: this repo's dashboard test against deployed stage, gated on `OPICE_SELF_READ_TOKEN`.

### Harness (`packages/harness/`)
The test-author-facing runtime, published to npm. `browserTest(name, fn)` wraps `bun:test` `describe` and manages an `agent-browser` session per scenario (open/close in before/afterAll). `step(name, fn)` is a reportable unit. The DSL — `el()`, `tid()`, `waitFor()` — shells out to the `agent-browser` CLI (`agent-browser.ts`); there is **no Playwright/Puppeteer**. `el('foo')` auto-wraps bare identifiers as `[data-testid="foo"]`; anything with CSS chars (`[ ] . # : > ` space) is treated as a raw selector. Prefer `data-testid`.

`reporter.ts` streams events to the platform and **auto-configures on import** from env (`OPICE_DSN` or individual `OPICE_*` vars). Reporting is **opt-in outside CI**: a local `bun test` while authoring would otherwise stream half-finished "running" runs to the shared dashboard. `OPICE_REPORT=always|never` overrides. Steps are fire-and-forget (drained by `flush()`); `POST /finish` is the **CLI's** job — the reporter writes a handoff file under `$TMPDIR/opice-handoffs/<pid>.json`, and `opice test` finalizes after `bun test` exits.

### CLI (`packages/cli/`)
The `opice` binary: `init` (scaffold `opice.config.json` + optional GH workflow), `test` (wraps `bun test`, injects `OPICE_*` from config + git, finalizes the run), `failures` (pull a failed run for re-eval), `users create` (mint a dashboard login via the admin token), `install-skills` (fetch the skills below into a target repo's `.claude/`).

## Skills & agents (`skills/`, `agents/`)
Claude Code workflows that drive authoring — installed into a target repo, not run from here:
- `opice-plan` — rough brief → `*.scenario.md` files (human reviews first).
- `opice-author` — one `*.scenario.md` → `*.test.ts`, walks the running app, picks selectors, runs until green.
- `opice-batch` — fans out one `opice-author` agent per scenario (parallel).
- `opice-reeval` — diagnose/fix a failed CI run without gutting assertions.
`agents/opice-author.md` is the subagent wrapper that invokes the `opice-author` skill in its own browser session.

## Conventions
- Tabs for indentation; no semicolons; single quotes (match existing files).
- TS is strict with `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` — env/index access uses bracket notation (`env['FOO']`).
