# Worker (`@opice/worker`)

CF Worker + two D1 databases + R2. Ingests test runs (reporter writes) and serves the dashboard RPC + auth. Read the root `CLAUDE.md` first.

## Critical invariants
- **One auth path.** Every surface authenticates through `authenticate(request)` in `principal.ts`, which resolves any credential into a single `Principal { subject, capabilities, scope }`. Handlers assert on **capabilities** (`read`/`write`/`admin` — what it may do) and **scope** (`all`/`project`/`run` — which data it may touch). Never re-implement credential parsing in a handler; add capability/scope helpers in `principal.ts`.
  - Resolution order: BetterAuth session cookie → `Authorization: Bearer <secret>` (a token row, or bootstrap `ADMIN_TOKEN`) → `?token=` / `opice_read` cookie (read-only share link).
  - `ENVIRONMENT === 'local'` opens the gate (no credential → full access) so the cross-origin Vite SPA can hit `/rpc` without a cookie dance. A *presented* Bearer still resolves to its real project even locally.
  - Share links (`?token=`/cookie) are **read-only by construction** — a write/admin secret presented that way is rejected.
  - Ingest requires `write` scoped to exactly one project (`routes/ingest.ts`).
- **`wrangler.jsonc` is auto-generated from `oblaka.ts` — never edit it by hand.**
- **Two separate D1 databases**: `opice` (app data, `migrations/`) and `opice-auth` (BetterAuth tables, `migrations/auth/`). Always migrate both. Auth migrations are generated, not hand-written: `bun run auth:migration`.

## Request routing (`src/index.ts` → `route()`)
One `fetch` handler dispatches by path prefix:
- `/api/v1/*` → ingest (reporter writes runs/scenarios/steps/screenshots)
- `/rpc` → dashboard RPC (single typed endpoint)
- `/auth/*` → BetterAuth
- `/screenshots/*` → R2 proxy (scope-checked)
- `/install.md`, everything else → dashboard SPA via the `ASSETS` binding

`scheduled()` cron (every 5 min) reaps runs abandoned mid-flight so they stop reading as "running". Reads also compute `incomplete` lazily (`STALE_RUN_MS` in `db.ts`) so local/lopata — where cron may not fire — stays correct.

## RPC layer (`rpc/` + `router.ts`)
A small home-grown tRPC-like layer. `router.ts` defines `appRouter` with zod-validated `input`/`output` per procedure; `rpc/dispatcher.ts` resolves dotted method paths, validates, and supports `{ batch: [...] }`. The dashboard imports `AppRouter` *as a type* (`@opice/worker/rpc`) — add a procedure and it's instantly typed client-side, no codegen. Errors are `RpcDispatchError` with an HTTP-status mapping (`deriveHttpStatus`); a 401 flips the dashboard's `AuthGate` to sign-in.

## Infra (`oblaka.ts`)
The IaC source of truth (D1×2, R2, Worker, cron, assets, vars per env: `local`/`stage`/`prod`). Local dev uses `lopata` (CF runtime on Bun) via `bun run dev`. Deploy is `bunx oblaka oblaka.ts --env=<env> --remote` in `.github/workflows/deploy.yml` (push `main` → stage, `deploy/prod` → prod). Stage/prod read `OPICE_ADMIN_TOKEN` / `OPICE_BETTER_AUTH_SECRET` from env and throw if missing.

## Conventions
D1 rows are snake_case; `db.ts` maps them to camelCase domain types (`types.ts`). Keep SQL ↔ mapping in `db.ts` — don't leak row shapes outward.
