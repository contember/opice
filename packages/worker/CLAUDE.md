# Worker (`@opice/worker`)

CF Worker + one D1 database + R2. Ingests test runs (reporter writes) and serves the dashboard RPC. Authentication of human operators is Cloudflare Access at the edge; authorization + audit + run-share capability tokens come from the **propustka** IAM Worker over the `IAM` service binding (`@propustka/client`). Read the root `CLAUDE.md` first.

## Critical invariants
- **Everything is propustka. TWO authorization mechanisms, split by ROUTE** (not by sniffing one endpoint). Add gate helpers in `principal.ts`; never parse credentials in a handler.
  1. **operator** — a human behind Cloudflare Access. `resolveOperator(request)` hands the injected `Cf-Access-Jwt-Assertion` to propustka `authenticate()` → an `AuthContext`; `can()`/`scopedTo()` are local pure checks. **IAM project key = the SLUG.** Used by `/rpc` + `/screenshots`.
  2. **capability** — every non-operator caller (CI ingest, the agent read DSN, the stage self-test, anonymous run-share visitors). A propustka **capability token** presented as `Bearer` (ingest) or `?token=`/`opice_read` cookie (share), redeemed over the IAM binding to a `Capability` whose `can(action, resource)` is exact-match. The Worker supplies the resource from the REQUEST (slug in the ingest URL, run/project id from the read params) — no grant enumeration. Used by `/api/v1/*` + `/s/*`.
  - **Action taxonomy** (mapped onto propustka roles admin=`*`, editor=`project.*`+`report.*`, viewer=`project.read`+`report.read`, no `roles.ts` edit): `project.read` (see a project + run list), `report.read` (read a run's scenarios/steps/screenshots), `project.write` (create projects, mint/revoke capabilities), `report.write` (write run data — the INGEST capability grants this).
  - **There are NO opice-owned credentials.** The `tokens` table is gone (migration 0007 drops it). DSNs (ingest/read) + share links are all propustka capability tokens; opice keeps only a metadata MIRROR (`capabilities` table) so the dashboard can list + revoke. Mint via `iam.issueCapability` (operator delegates), revoke via `iam.revokeCapability`.
- **ACCESS TOPOLOGY — opice is mostly NOT behind Access.** Cloudflare Access is the operator LOGIN PROVIDER, not a perimeter. COVERED by Access: `/rpc`, `/screenshots/*`, the operator SPA shell (so the JWT header is injected). PUBLIC (Access bypass): `/api/v1/*` (ingest) + `/s/*` (the share/read SPA + `/s/rpc` + `/s/screenshots`) + `/install.md`. Capability tokens work on the public paths because redeeming them is a binding call that never traverses Access.
- **`wrangler.jsonc` is auto-generated from `oblaka.ts` — never edit it by hand.**
- **One D1 database**: `opice` (app data, `migrations/`). The BetterAuth `opice-auth` DB is gone — identity lives in the IAM directory.

## Request routing (`src/index.ts` → `route()`)
One `fetch` handler dispatches by path prefix:
- `/__dev/login?as=<email>` → DEV-only operator persona switch (sets the FakeIamClient cookie); 404 off-local
- **PUBLIC:** `/api/v1/<slug>/*` → ingest (Bearer ingest capability); `/s/rpc` → read-only share RPC (`shareRouter`); `/s/screenshots/*` → capability-checked R2 proxy; `/s/*` → share SPA shell (`?token=`→cookie exchange); `/install.md`
- **BEHIND ACCESS:** `/rpc` → operator RPC (`appRouter`); `/screenshots/*` → operator R2 proxy; everything else → operator SPA shell

`scheduled()` cron (every 5 min) reaps runs abandoned mid-flight so they stop reading as "running". Reads also compute `incomplete` lazily (`STALE_RUN_MS` in `db.ts`) so local/lopata — where cron may not fire — stays correct.

## RPC layer (`rpc/` + `router.ts`)
A small home-grown tRPC-like layer (`rpc/`). **Two routers:** `router.ts` → `appRouter` (the OPERATOR API at `/rpc`, context = `AuthContext`); `shareRouter.ts` → `shareRouter` (the PUBLIC read-only API at `/s/rpc`, context = a redeemed `Capability`). Both are imported by the dashboard *as types* from `@opice/worker` (`AppRouter` for the operator client, `ShareRouter` for the share-view client) — add a procedure and it's instantly typed client-side, no codegen. `session.me` is the operator who-am-I (identity + `canCreateProjects`). Errors are `RpcDispatchError`; a 401 from `/rpc` flips the dashboard to the access-required screen (Access owns operator sign-in), an invalid `/s/rpc` token reads 404. Capability mirror: `db.ts` `createCapability`/`listRunShares`/`listProjectCapabilities`/`getCapability`/`markCapabilityRevoked` over the `capabilities` table (migration 0007) — metadata only, so `shares.list`/`projects.listKeys`/`revoke` have something to enumerate (propustka has issue/redeem/revoke but no list).

## Infra (`oblaka.ts`)
The IaC source of truth (D1, R2, Worker, cron, assets, the `IAM` service binding off-local, vars per env: `local`/`stage`/`prod`). Local dev uses `lopata` (CF runtime on Bun) via `bun run dev` — no Access, no IAM Worker: `src/iam.ts` swaps in the persona-backed `FakeIamClient` (`DEV='true'`). Deploy is `bunx oblaka oblaka.ts --env=<env> --remote` in `.github/workflows/deploy.yml` (push `main` → stage, `deploy/prod` → prod).

## Conventions
D1 rows are snake_case; `db.ts` maps them to camelCase domain types (`types.ts`). Keep SQL ↔ mapping in `db.ts` — don't leak row shapes outward.
