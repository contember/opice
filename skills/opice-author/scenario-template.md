# <Short scenario title — becomes the browserTest() name>

URL: http://localhost:15180/<deepest-stable-route-for-this-flow>
Hash: <playground-hash-or-omit>
Seed: <seed-name-if-this-flow-needs-fixtures-or-omit>

## Context

A sentence or two on what feature is being tested and what state the app
should be in. Prefer to **deep-link** straight onto the surface under test via
`URL:` above — auth is a precondition, not a step (only start at `/` if the
flow is *about* logging in/out). The opice-author skill won't seed anything; if
this flow needs data, name the (idempotent, composable) seed in `Seed:` and
make sure it's applied before running. App-wide truths (auth model, selector
strategy, timeouts, available seeds) live in the suite's `invariants.md` — don't
restate them here.

## Steps

1. <Plain-English step. Can mix action + assertion.>
2. <Another step. Click X, then expect Y to be visible.>
3. <Etc. One numbered item = one `step()` in the generated test.>

## Notes (optional)

- Anything the skill should know about brittleness, race conditions,
  required `data-testid`s, etc.
- Remember the DB is shared and never reset: assert on the presence of a
  uniquely-identified thing, never counts/emptiness. If this flow *creates*
  data, stamp it with a unique per-run marker (e.g. a `Date.now()` suffix) and
  assert on that exact value.
