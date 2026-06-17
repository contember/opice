# Opice

AI-driven E2E browser test harness. Human-readable scenarios → LLM-generated tests → deterministic CI runs → centralized reporting.

> Status: **v1 done**. Single-user, single-tenant. Ready to dogfood.

## What it is

A monkey-testing harness (hence "opice") for web apps:

1. You write a human-readable scenario in markdown (`login.scenario.md`).
2. The `opice-author` Claude Code skill walks the running app via `opice-browser` (a stateful [Playwright](https://playwright.dev) browser), generates a `*.test.ts` file with `data-testid`/role/label selectors, verifies it passes, commits.
3. CI runs the generated tests deterministically (no LLM in the loop) via `opice test`, streaming results + screenshots to the central reporting platform.
4. The dashboard SPA shows the runs / scenarios / steps / screenshots, type-safely fetched via the worker's tRPC-like `/rpc` endpoint.

## Architecture

- **Tests live in your repo.** Reviewed in PRs, atomic with UI changes, debuggable locally.
- **Browser runs in CI** (or locally) — Playwright in-process under `bun test`. No remote browser farm.
- **Reporting platform on Cloudflare:** Worker (`/api/v1/*` ingest, `/rpc` for dashboard, `/screenshots/*` proxy), D1 for run metadata, R2 for screenshots, served SPA via `ASSETS` binding.
- **Dashboard SPA** with buzola routing + React Query, RPC client typed from the worker's `AppRouter`.
- **AI authoring is local** — Claude Code skill on your machine. No server-side LLM.

## Repo layout

```
opice/
├── packages/
│   ├── harness/    # @opice/harness — Playwright runtime: el(), byRole(), browserTest(), step(), command()
│   ├── browser/    # @opice/browser — opice-browser: stateful Playwright CLI for authoring (CDP)
│   ├── worker/     # CF Worker — D1 + R2 + ingest API + /rpc + dashboard ASSETS
│   ├── dashboard/  # React SPA (buzola + react-query), built into worker/ASSETS
│   └── cli/        # opice CLI — init + test wrapper
├── skills/
│   └── opice-author/  # Claude Code skill, install via bun run skills:install
├── scripts/
│   └── install-skills.ts
└── okena.yaml      # `okena` services: worker (18181) + dashboard vite (18182)
```

## Quickstart

```bash
# 1. Boot the platform
bun install
bun --filter @opice/worker run db:migrate:local
bun --filter @opice/worker run dev      # worker on http://localhost:18181

# In another terminal:
bun --filter @opice/dashboard run dev   # vite dev on http://localhost:18182
# Or just `okena` if you have it — see okena.yaml

# 2. Create a project in the dashboard → "New project".
#    Locally the operator gate is open (a default-admin persona — no Cloudflare
#    Access needed), so you land straight in. Creating a project shows its
#    OPICE_DSN (write) + OPICE_READ_DSN once — copy the OPICE_DSN.

# 3. Wire opice into your project
cd ~/projects/my-app
bunx opice init --project=my-app --endpoint=http://localhost:18181 --with-workflow
echo "OPICE_DSN=<the OPICE_DSN from step 2>" >> .env

# 4. Author a scenario
echo "# Login flow ... " > tests/login.scenario.md
# In Claude Code: /opice-author tests/login.scenario.md

# 5. Run + report
bunx opice test tests/login.test.ts
# Watch results stream into http://localhost:18182
# Or, no platform needed — write a local HTML report (the dashboard, offline):
bunx opice test tests/login.test.ts --report   # writes .opice/report.html
```

## Deploy

GitHub Actions live in [`.github/workflows/`](.github/workflows):

- **`ci.yml`** — runs on every PR + push to main. Typechecks every package, generates buzola routes, builds the dashboard.
- **`deploy.yml`** — push to `main` deploys `stage`; push to `deploy/prod` deploys `prod`. `workflow_dispatch` is also wired up as a manual backup with an env picker. Both targets run `bunx oblaka oblaka.ts --env=<env> --state-namespace=opice-state --remote`, which provisions D1 (`opice`) + R2 if missing (oblaka also auto-creates the `opice-state` KV namespace it stores resource state in), deploys the worker, then applies pending D1 migrations.

Operator authentication is **Cloudflare Access** at the edge; authorization + audit + run-share capability tokens come from the **propustka** IAM Worker, reached over the `IAM` service binding (declared off-local in `oblaka.ts`). opice is not fully behind Access — anonymous run-share links + the machine ingest/read DSN plane reach the Worker directly (see `packages/worker/CLAUDE.md`).

Required repository secrets:

| Secret | Used by |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | oblaka + wrangler |
| `CLOUDFLARE_ACCOUNT_ID` | oblaka + wrangler |
| `OPICE_SELF_READ_TOKEN` | the self-test job (a global read DSN token, minted once in the dashboard) |

Set distinct values per GitHub *environment* (`stage` / `prod`) and the workflow picks them up via the `environment:` key.

## v1 roadmap

- [x] Week 1: `@opice/harness` extracted from bindx prototype
- [x] Week 2: CF Worker + D1 + R2 + SPA dashboard
- [x] Week 3: `opice-author` Claude skill
- [x] Week 4: `@opice/cli` (init + test) + GH Action template + dogfooded on bindx

## Non-goals (v1)

- Visual regression (screenshots are evidence, not asserts)
- Multi-tenant SaaS (single-org — operators sign in via Cloudflare Access, authorization from the propustka IAM directory; plus per-run capability-token links for read-only sharing)
- AI in CI loop (authoring is local only)
- Browser farm in platform (you run your own browser)

See the **Non-goals** and **Architecture** sections above for the design decisions and locked-in tradeoffs.

## License

MIT
