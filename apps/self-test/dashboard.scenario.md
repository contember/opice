# Stage dashboard end-to-end

URL: https://stage-opice-worker.contember.workers.dev

The opice stage dashboard testing itself through the PUBLIC share surface
(`/s/*`, outside Cloudflare Access). A project-scoped read token is appended as
a query param on the first visit so the `opice_read` cookie gets set, then the
rest of the scenario navigates client-side.

## Context

- Stage worker is deployed (`main` → stage CI).
- A project named `opice-self` exists (slug + display name "Opice self-test").
- The operator dashboard is behind Cloudflare Access; an anonymous, token-bearing
  visitor can only reach the public `/s/*` share views.
- `OPICE_SELF_READ_TOKEN` is a PROJECT-scoped read capability for `opice-self`
  (same value as the worker's stage `READ_TOKEN` secret). Entry URL:
  `/s/p/opice-self?token=<token>` — the worker exchanges `?token=` for the
  `opice_read` cookie and 302s to the clean `/s/p/opice-self`.

## Steps

1. The project share view loads with the project name "Opice self-test" as the
   `main h1` heading.
2. At least one run is listed (a `share-run-row`).
3. Clicking the first run navigates to its share run view
   (`/s/p/opice-self/r/:runId`).
4. The run detail renders — its heading reads `Run <id>`.
