# Dashboard (`@opice/dashboard`)

React 19 SPA: `@buzola/router` (file-based routes in `src/routes/`), `@tanstack/react-query`. Built into `dist/` and served by the worker's `ASSETS` binding (oblaka sets `run_worker_first: true` so the read-cookie exchange runs before static serving). Read the root `CLAUDE.md` first.

## Auth (no in-app login)
Operators sign in via **Cloudflare Access** at the edge — there is no email/password form. `lib/session.ts` exposes `useMe()` (a react-query hook over `rpc.session.me()` → `{ authenticated, email, canCreateProjects, canManageTokens }`) and `logout()` (→ `/cdn-cgi/access/logout`). `AuthGate` renders the app for an operator OR an anonymous run-share visitor (`authenticated: false`), and an **access-required** screen when `/rpc` returns 401 (the `useAuthRequired()` store, flipped in `main.tsx`). Operator-only UI (New project, token manager, share manager) is gated on the `useMe()` flags.

## Codegen — required before typecheck/build
`bun run gen` regenerates `src/buzola.gen.ts` from `src/routes/`. It runs through Bun (`scripts/gen.ts`), not `bunx buzola`, because the shipped buzola CLI is Node and can't load TSX routes. `build`/`typecheck` already chain `gen`; run it manually after adding or moving a route.

## RPC client
`lib/rpc-client.ts` builds a typed Proxy over `AppRouter` (imported *as a type* from `@opice/worker/rpc`): `client.runs.get({...})` becomes a POST to `/rpc`, fully typed end to end, no codegen. A 401 from RPC flips `AuthGate` to the access-required screen.
