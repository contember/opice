# Dashboard (`@opice/dashboard`)

React 19 SPA: `@buzola/router` (file-based routes in `src/routes/`), `@tanstack/react-query`. Built into `dist/` and served by the worker's `ASSETS` binding (oblaka sets `run_worker_first: true` so the read-cookie exchange runs before static serving). Read the root `CLAUDE.md` first.

## Auth (no in-app login)
Operators sign in via **Cloudflare Access** at the edge — there is no email/password form. `lib/session.ts` exposes `useMe()` (a react-query hook over `rpc.session.me()` → `{ authenticated: true, email, canCreateProjects }`) and `logout()` (→ `/cdn-cgi/access/logout`). `AuthGate` lives **inside `_layout.tsx`** (NOT `main.tsx`), wrapping only the operator branch: it renders the app for an authenticated operator, and an **access-required** screen when `/rpc` returns 401 (the `useAuthRequired()` store, flipped in `main.tsx`). Operator-only UI (New project, project keys in settings, share manager) is gated on `me.canCreateProjects`.

## One layout, two shells: operator vs public share
`_layout.tsx` is the single root layout. It forks on the URL:
- `/s/*` → `ShareShell`: the PUBLIC read-only share view at `/s/p/:slug/r/:runId` (the `share-run.tsx` route's `.route()` pattern). **No `AuthGate`, no `session.me`, no operator chrome** — an anonymous visitor lands here. It uses the share RPC client (`lib/share-client.ts` → `/s/rpc`, `ShareRouter`), whose `?token=` is exchanged for the `opice_read` cookie by the Worker before the SPA loads. Nothing under `/s/*` may call `/rpc`.
- everything else → `OperatorShell` wrapped in `AuthGate`: operator chrome behind Cloudflare Access, talking to the operator RPC client (`lib/client.ts` → `/rpc`).

The fork is a component-boundary branch (not a conditional hook): session hooks live entirely inside `OperatorShell`, so the share branch never touches the operator surface.

`components/RunDetail.tsx` is the shared read-only run renderer (run header + scenario workbench + steps) reused by both the operator run page and the share view; each caller passes the already-fetched `run`/`scenarios` plus a `loadSteps` binding for its own client.

## Codegen — required before typecheck/build
`bun run gen` regenerates `src/buzola.gen.ts` from `src/routes/`. It runs through Bun (`scripts/gen.ts`), not `bunx buzola`, because the shipped buzola CLI is Node and can't load TSX routes. `build`/`typecheck` already chain `gen`; run it manually after adding or moving a route.

## RPC client
`lib/rpc-client.ts` builds a typed Proxy over `AppRouter` (imported *as a type* from `@opice/worker/rpc`): `client.runs.get({...})` becomes a POST to `/rpc`, fully typed end to end, no codegen. A 401 from RPC flips `AuthGate` to the access-required screen.
