# Stage dashboard end-to-end

URL: https://stage-opice-worker.contember.workers.dev

The opice stage dashboard testing itself. Read-token is appended as a
query param on the first visit so the cookie gets set, then the rest of
the scenario navigates client-side.

## Context

- Stage worker is deployed (`main` → stage CI).
- A project named `opice-self` exists (slug + display name).
- Read access requires `OPICE_SELF_READ_TOKEN` in env (same value as the
  worker's stage `READ_TOKEN` secret).

## Steps

1. The home page loads with the heading "Projects".
2. The "Opice self-test" project is in the project list (link to `/p/opice-self`).
3. Clicking that link navigates to the project detail page, heading is "Opice self-test".
4. The breadcrumb shows `Projects / Opice self-test`.
5. Going back to home (`a[href="/"]` in the breadcrumb) returns to the project list.
