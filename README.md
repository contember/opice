# Opice

AI-driven E2E browser test harness. Human-readable scenarios → LLM-generated tests → deterministic CI runs → centralized reporting.

> Status: **v1 done**. Single-user, single-tenant. Ready to dogfood.

## What it is

A monkey-testing harness (hence "opice") for web apps:

1. You write a human-readable scenario in markdown (`login.scenario.md`).
2. The `opice-author` Claude Code skill walks the running app via [`agent-browser`](https://github.com/.../agent-browser), generates a `*.test.ts` file with `data-testid` selectors, verifies it passes, commits.
3. CI runs the generated tests deterministically (no LLM in the loop) via `opice test`, streaming results + screenshots to the central reporting platform.
4. The dashboard SPA shows the runs / scenarios / steps / screenshots, type-safely fetched via the worker's tRPC-like `/rpc` endpoint.

## Architecture

- **Tests live in your repo.** Reviewed in PRs, atomic with UI changes, debuggable locally.
- **Browser runs in CI** (or locally), driven by `agent-browser` CLI. No remote browser farm.
- **Reporting platform on Cloudflare:** Worker (`/api/v1/*` ingest, `/rpc` for dashboard, `/screenshots/*` proxy), D1 for run metadata, R2 for screenshots, served SPA via `ASSETS` binding.
- **Dashboard SPA** with buzola routing + React Query, RPC client typed from the worker's `AppRouter`.
- **AI authoring is local** — Claude Code skill on your machine. No server-side LLM.

## Repo layout

```
opice/
├── packages/
│   ├── harness/    # @opice/harness — runtime: el(), tid(), waitFor(), browserTest(), step()
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
bun --filter @opice/worker run db:migrate:auth:local   # BetterAuth tables (separate D1)
bun --filter @opice/worker run dev      # worker on http://localhost:18181

# In another terminal:
bun --filter @opice/dashboard run dev   # vite dev on http://localhost:18182
# Or just `okena` if you have it — see okena.yaml

# 2. Create a project (returns an API key — save it)
curl -X POST http://localhost:18181/api/v1/admin/projects \
  -H 'x-admin-token: local-admin' \
  -H 'content-type: application/json' \
  -d '{"slug":"my-app","name":"My App"}'

# 2b. Create a dashboard login (email + password; every user is admin).
#     The read gate is open locally, so login is only required on stage/prod —
#     but this is how you mint accounts. Prints a generated password if omitted.
bunx opice users create me@example.com --endpoint=http://localhost:18181 --admin-token=local-admin

# 3. Wire opice into your project
cd ~/projects/my-app
bunx opice init --project=my-app --endpoint=http://localhost:18181 --with-workflow
echo "OPICE_API_KEY=<key-from-step-2>" >> .env

# 4. Author a scenario
echo "# Login flow ... " > tests/login.scenario.md
# In Claude Code: /opice-author tests/login.scenario.md

# 5. Run + report
bunx opice test tests/login.test.ts
# Watch results stream into http://localhost:18182
```

## Deploy

GitHub Actions live in [`.github/workflows/`](.github/workflows):

- **`ci.yml`** — runs on every PR + push to main. Typechecks every package, generates buzola routes, builds the dashboard.
- **`deploy.yml`** — push to `main` deploys `stage`; push to `deploy/prod` deploys `prod`. `workflow_dispatch` is also wired up as a manual backup with an env picker. Both targets run `bunx oblaka oblaka.ts --env=<env> --state-namespace=opice-state --remote`, which provisions D1 (both `opice` and the separate `opice-auth`) + R2 if missing (oblaka also auto-creates the `opice-state` KV namespace it stores resource state in), deploys the worker, then applies pending D1 migrations for both databases.

Required repository secrets:

| Secret | Used by |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | oblaka + wrangler |
| `CLOUDFLARE_ACCOUNT_ID` | oblaka + wrangler |
| `OPICE_READ_TOKEN` | baked into worker `vars` as `READ_TOKEN` (read gate for shareable links) |
| `OPICE_ADMIN_TOKEN` | baked into worker `vars` as `ADMIN_TOKEN` (project-create + user-create endpoints) |
| `OPICE_BETTER_AUTH_SECRET` | baked into worker `vars` as `BETTER_AUTH_SECRET` (session signing, ≥ 32 chars) |

Set distinct values per GitHub *environment* (`stage` / `prod`) and the workflow picks them up via the `environment:` key.

## v1 roadmap

- [x] Week 1: `@opice/harness` extracted from bindx prototype
- [x] Week 2: CF Worker + D1 + R2 + SPA dashboard
- [x] Week 3: `opice-author` Claude skill
- [x] Week 4: `@opice/cli` (init + test) + GH Action template + dogfooded on bindx

## Non-goals (v1)

- Visual regression (screenshots are evidence, not asserts)
- Multi-tenant SaaS (single-org — email+password login via BetterAuth, one role: everyone is admin; plus `READ_TOKEN` links for read-only sharing)
- AI in CI loop (authoring is local only)
- Browser farm in platform (you run your own browser)

See the **Non-goals** and **Architecture** sections above for the design decisions and locked-in tradeoffs.

## License

MIT
