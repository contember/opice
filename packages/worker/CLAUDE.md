# Worker (`@opice/worker`)

CF Worker + one D1 database + R2. Ingests test runs (reporter writes) and serves the dashboard RPC. Authentication of human operators is Cloudflare Access at the edge; authorization + audit + run-share capability tokens come from the **propustka** IAM Worker over the `IAM` service binding (`@propustka/client`). Read the root `CLAUDE.md` first.

## Critical invariants
- **Three credential planes, one resolver.** `resolveCaller(request)` in `principal.ts` normalizes any caller into a single `Caller` the handlers gate on. Never re-implement credential parsing in a handler; add caller-aware helpers in `principal.ts`.
  1. **operator** — a human at the dashboard. Cloudflare Access authenticates at the edge (`Cf-Access-Jwt-Assertion`); propustka resolves the principal + permissions; `can()`/`scopedTo()` are local pure checks. **The IAM-facing project key is the project SLUG.**
  2. **machine** — CI ingest (`write`), the authoring agent's read DSN (`read`), the stage self-test (`read`). An app-local hashed token row (`tokens`, migration 0003) presented as `Authorization: Bearer`, resolved WITHOUT Access or propustka — opice's **data plane**, the Sentry-DSN equivalent.
  3. **share** — an anonymous run-share visitor. A propustka **capability token** via `?token=`/`opice_read` cookie, redeemed to a `Capability` (exact `can(action, resource)`).
  - Resolution order: explicit `Bearer` (machine) → forwarded Access JWT (operator) → `?token=`/cookie (share/app-local read) → operator fallback (local persona-fake opens the gate; off-local → 401). Putting machine/share ahead of the operator FALLBACK is what lets a local `?token=`/`Bearer` resolve to the right plane.
  - **Action taxonomy** (mapped onto propustka roles admin=`*`, editor=`project.*`, viewer=`project.read`, no `roles.ts` edit): `project.read` (read a project + its runs), `project.write` (create projects, mint/revoke shares), `token.manage` (data-plane token inventory; admin only).
  - Share links (`?token=`/cookie) are **read-only by construction** — a `write` token presented that way never resolves there; a run-scoped legacy token row is dead (migration 0007).
  - Ingest is its own resolver (`resolveIngestProject`): a single project-scoped `write` machine token → its project. Never an operator/share.
- **opice is NOT fully behind Access.** Anonymous share links + the Bearer machine plane must reach the Worker. Access forwards the operator JWT but allows unauthenticated requests through; the Worker resolves all three planes itself (see oblaka.ts).
- **`wrangler.jsonc` is auto-generated from `oblaka.ts` — never edit it by hand.**
- **One D1 database**: `opice` (app data, `migrations/`). The BetterAuth `opice-auth` DB is gone — identity lives in the IAM directory.

## Request routing (`src/index.ts` → `route()`)
One `fetch` handler dispatches by path prefix:
- `/__dev/login?as=<email>` → DEV-only operator persona switch (sets the FakeIamClient cookie); 404 off-local
- `/api/v1/*` → ingest (reporter writes runs/scenarios/steps/screenshots)
- `/rpc` → dashboard RPC (single typed endpoint)
- `/screenshots/*` → R2 proxy (scope-checked)
- `/install.md`, everything else → dashboard SPA via the `ASSETS` binding

`scheduled()` cron (every 5 min) reaps runs abandoned mid-flight so they stop reading as "running". Reads also compute `incomplete` lazily (`STALE_RUN_MS` in `db.ts`) so local/lopata — where cron may not fire — stays correct.

## RPC layer (`rpc/` + `router.ts`)
A small home-grown tRPC-like layer. `router.ts` defines `appRouter` with zod-validated `input`/`output` per procedure; `rpc/dispatcher.ts` resolves dotted method paths, validates, and supports `{ batch: [...] }`. The dashboard imports `AppRouter` *as a type* (`@opice/worker/rpc`) — add a procedure and it's instantly typed client-side, no codegen. `session.me` is the dashboard's who-am-I (operator identity + capability flags). Errors are `RpcDispatchError` with an HTTP-status mapping (`deriveHttpStatus`); a 401 flips the dashboard's `AuthGate` to the access-required screen (Access owns operator sign-in). Run-shares are propustka capability tokens; the local `shares` table (migration 0007) mirrors them so `shares.list`/`revoke` have something to enumerate (the propustka contract has issue/redeem/revoke but no list).

## Infra (`oblaka.ts`)
The IaC source of truth (D1, R2, Worker, cron, assets, the `IAM` service binding off-local, vars per env: `local`/`stage`/`prod`). Local dev uses `lopata` (CF runtime on Bun) via `bun run dev` — no Access, no IAM Worker: `src/iam.ts` swaps in the persona-backed `FakeIamClient` (`DEV='true'`). Deploy is `bunx oblaka oblaka.ts --env=<env> --remote` in `.github/workflows/deploy.yml` (push `main` → stage, `deploy/prod` → prod).

## Conventions
D1 rows are snake_case; `db.ts` maps them to camelCase domain types (`types.ts`). Keep SQL ↔ mapping in `db.ts` — don't leak row shapes outward.
