# CLAUDE.md

Opice is an AI-driven E2E browser test harness. The pipeline: human-readable `*.scenario.md` → LLM-generated `*.test.ts` (authored locally via a Claude Code skill) → deterministic CI runs (no LLM in the loop) → centralized reporting on a Cloudflare platform.

Two distinct things share the name "opice":
- **The product** the test author uses — `@opice/harness` (test runtime) + `@opice/cli` (`opice` binary) + the Claude Code skills, dropped into *their* repo.
- **This platform repo** — the Cloudflare Worker + D1 + R2 + dashboard SPA that ingests and displays runs.

Tests live in the *user's* repo, not here. The browser runs in *their* CI (Playwright in-process under `bun test`). This repo only stores and displays results. See `README.md` for the design rationale and locked-in non-goals (no visual regression, no multi-tenant, no AI in CI, no browser farm).

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
- `packages/browser/` — `opice-browser`, the stateful Playwright authoring CLI. See below.
- `packages/cli/` — the `opice` binary. See below.
- `packages/worker/` — CF Worker + D1×2 + R2 ingest/RPC/auth backend. **Read `packages/worker/CLAUDE.md`** before editing.
- `packages/dashboard/` — React 19 SPA. **Read `packages/dashboard/CLAUDE.md`** before editing.
- `apps/self-test/` — dogfood smoke test: this repo's dashboard test against deployed stage, gated on `OPICE_SELF_READ_TOKEN`.

### Harness (`packages/harness/`)
The test-author-facing runtime, published to npm. **Backed by Playwright, in-process** — `bun test` drives Playwright directly; there is no CLI or daemon in the test/CI path (and no agent-browser). `browserTest(name, fn)` wraps `bun:test` `describe` and launches a fresh Playwright browser+context+page per scenario (`context.ts`; `beforeAll`/`afterAll`). `step(name, fn)` is a reportable async unit. The DSL is **async** and returns Playwright `Locator`s: `el()`/`tid()` (`element.ts`), `byRole()`/`byLabel()`/`byText()` (`accessible.ts`, native getBy*), navigation (`navigation.ts`). `el('foo')` → `getByTestId('foo')`; anything with CSS chars (`[ ] . # : > ` space) is a raw selector. `expect` is re-exported from `@playwright/test` (works under `bun:test`). `command()`/`call()`/`loadUserCommands()` (`command.ts`) are the shared registry for user-land `browser-tools.ts` verbs. **`bun:test` is lazy-`require`d in `scenario.ts`** so the package is importable under plain Node (the daemon needs that). Conditional exports: `bun`→`src/*.ts`, node→`dist/*.js` (run `bun run build`). Prefer `data-testid`, then role/label.

### opice-browser (`packages/browser/`)
The stateful authoring CLI (`@opice/browser`, bin `opice-browser`), **authoring-only — never in CI**. `launch` spawns a long-running **server** (`server.ts`, the hidden `__serve` subcommand) that itself spawns Chrome, holds ONE `connectOverCDP` connection + page for its whole life, and serves verbs over a per-session unix socket; verb commands (`session.ts`) are thin socket clients. Holding the connection — plus enabling focus emulation on the connected page — is what lets transient page state (keyboard focus, an open Radix popover, in-flight navigation) survive between separate verb commands, exactly like the held page in a test. Built-in verbs (`builtins.ts`: open/click/fill/byRole/byLabel/byText/aria-snapshot/…) use the same `command()` primitive as user verbs, plus any from a repo's `browser-tools.ts`. **Runs under Node, not Bun** — `connectOverCDP`'s websocket can't complete the handshake under Bun (in-process `chromium.launch()` is fine under Bun, which is why the harness stays in-process); `cli.ts` re-execs under node if launched via bun. Bin is the built `dist/cli.js`; `bun run build` first. Named sessions via `--session`/`OPICE_BROWSER_SESSION` (own server + socket each) for parallel `opice-batch` authors.

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
