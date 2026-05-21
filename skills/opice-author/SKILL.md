---
name: opice-author
description: >
  Author an opice E2E browser test from a human-readable scenario file.
  Takes a `*.scenario.md`, walks the running app via opice-browser (a stateful
  Playwright browser), picks selectors (preferring `data-testid`, then
  accessible roles/labels), generates a `*.test.ts` using `@opice/harness`, and
  verifies it passes by running `bun test`.

  Trigger when the user says "/opice-author <file>", "write an opice test
  for this scenario", "generate opice test from <md file>", or hands you a
  *.scenario.md and asks for a test.
allowed-tools: Bash(opice-browser:*), Bash(bun:*), Bash(opice:*), Bash(git:*), Read, Edit, Write, Glob, Grep
---

# opice-author — scenario → test

This skill turns a human-readable scenario into a working `@opice/harness`
test by actually driving the app in a real browser, recording the
selectors that worked, and then writing a test that uses those same
selectors.

It does **NOT** commit unless the user explicitly asks (per their global
git rules).

## Authoring rules — read first

opice tests run against a **shared, long-lived database that is never reset**
(per-test cleanup is too expensive). Every run leaves data behind: seeds, and
rows created by earlier runs of *this* and *other* scenarios. The browser
session is fresh each scenario, but the data is not. Authoring has to assume
arbitrary pre-existing data at all times.

1. **Never assert on counts, emptiness, or "the only one".** No "the list has
   3 rows", no "No results found", no "this is the only program". These pass
   only by luck of nobody having seeded yet. Assert the **presence of a
   uniquely-identified thing** instead — `el(...).text` *contains* the specific
   name/id your scenario is about.

2. **Stamp anything you create with a unique per-run marker.** A scenario that
   creates an entity must fill its name (or another searchable field) with a
   value unique to this run — e.g. `Opice <flow> ${Date.now()}` — and assert on
   *that exact string*. Each run then asserts on its own artifact, never
   collides with leftovers, and the rows stay sweepable later. Never reuse a
   fixed name for created data.

3. **Deep-link to the surface under test; auth is a precondition, not a step.**
   Use the deepest stable route in the scenario's `URL:` (e.g.
   `/app/programs/create`), not a top-level page you click through. Don't author
   a login/navigation preamble into scenarios that aren't *about* login — if the
   app authenticates ambiently (dev session token, injected state), deep-linking
   lands you already authenticated. Only start at `/` when the auth transition
   itself is the subject.

4. **Read the suite's context/invariants file before authoring.** If the
   scenario or its directory references an ambient-context file — e.g.
   `tests/browser/invariants.md` — read it first. It holds app-wide truths
   (auth model, base URLs, selector strategy, first-load timeouts, available
   seeds, known overlays) so individual scenarios stay short. Apply those
   invariants even when a scenario doesn't restate them.

5. **Fixtures must coexist.** If a scenario declares a `Seed:` precondition it
   must be idempotent and keyed by stable ids so it composes with every other
   seed already in the DB. Don't author against a seed that fights another for
   the same row.

## Inputs

- **scenario file**: a path to a `*.scenario.md` — the user will give you
  this (or you find it via Glob).
- **playground URL**: usually declared inside the scenario as
  `URL: http://localhost:5173` or similar. If not declared, check
  `PLAYGROUND_URL` env, then ask.
- **output path**: defaults to the same directory as the scenario, with the
  `.scenario.md` suffix replaced by `.test.ts`. Confirm before overwriting.

## Workflow

### 1. Read and parse the scenario

A scenario file looks like this (see `scenario-template.md`):

```markdown
# DataGrid renders and is interactive

URL: http://localhost:15180
Hash: datagrid

## Steps

1. The data grid is visible with at least 2 rows
2. Header for "Title" exists and shows the label "Title"
3. Click row 0 — it gets highlighted (`[data-highlighted]`)
4. Click row 1 — highlight moves to row 1
```

Parse the metadata (URL, Hash) and each numbered step. Steps may
interleave actions ("click X", "type Y") with assertions ("then Z is
visible"). Treat each numbered item as one `step()` in the generated
test.

### 2. Verify project setup

Run from the project root (where the scenario lives or its closest
ancestor with a `package.json`).

```bash
# Check the package has @opice/harness available
grep -q '@opice/harness' package.json || grep -r '@opice/harness' packages/*/package.json 2>/dev/null
```

If not installed, stop and tell the user to add it.

### 3. Walk the scenario in opice-browser

`opice-browser` is a stateful Playwright browser: `launch` starts it (it
persists between calls), then each verb drives the live page. The verbs are the
**same vocabulary the test will use** — `byRole`/`byLabel`/`el` map 1:1 onto the
harness DSL, so the walk is a transcript of the test you're about to write.

```bash
opice-browser launch <URL>#<Hash>
opice-browser aria-snapshot main      # the agent's view of the page (ARIA tree)
```

For each step:

- **`aria-snapshot`** to see what's on the page (roles + accessible names) after
  a navigation or click. This is the agent's "what's on screen".
- **Resolve a selector / locator**, in this preference order:
  1. `data-testid` if the element has one — `opice-browser click <testid>` (a
     bare word is a test-id). In the test: `el('<testid>')`.
  2. An accessible role + name — `opice-browser byRole button click --name Save`.
     In the test: `byRole('button', 'Save')`. Reliable now (real Playwright
     gestures), so reach for it freely when you don't own the markup.
  3. A `<label>` for form controls — `opice-browser byLabel Email fill --value …`
     → `byLabel('Email')`.
  4. Avoid index-based or class-only selectors — they break on UI changes.
- **Perform the action** (`click` / `fill` / `press`) and watch it land.
- **Verify the expectation** (`opice-browser text <sel>`, or re-snapshot).
- Record the verb + selector you used. This is what goes into the test.

If a domain flow needs a repeated multi-step gesture (e.g. a custom
select widget), check for a repo `browser-tools.ts` — `opice-browser commands`
lists any user-land verbs. Prefer a shared verb over hand-driving the sequence;
the test can call it too (see step 4).

If a step's action fails (element not present), tell the user. Don't
fabricate selectors in the generated test that you couldn't make work
live — that's the whole point of this skill.

When done walking, `opice-browser quit` to free the browser (the test run in
step 5 launches its own in-process browser — the daemon is authoring-only).

### 4. Generate the test file

Use this template (see `test-template.ts` for the full version):

```ts
import { test, describe } from 'bun:test'
import { browserTest, el, byRole, byLabel, step, expect } from '@opice/harness'

browserTest('<Scenario Title>', () => {
	test('walkthrough', async () => {
		await step('<step 1 description>', async () => {
			await expect(el('<test-id>')).toContainText('<text>')
		})

		await step('<step 2 description>', async () => {
			await byRole('button', 'Save').click()
			await expect(el('<expected>')).toBeVisible()
		})
	}, 60_000)
}, '<hash>')
```

Notes:

- **The DSL is async.** `el`/`byRole`/`byLabel` return Playwright `Locator`s;
  every action and read is awaited. `step` bodies are `async` and each `step`
  call is awaited. Forgetting an `await` is the most common authoring bug.
- **Use retrying assertions, not manual polling.** `await expect(el(x))
  .toHaveText(...)` / `.toContainText(...)` / `.toBeVisible()` auto-wait and
  retry — they replace the old `waitFor(() => el(x).exists)` pattern and are far
  less flaky. Keep `await waitFor(async () => …)` only for predicates that don't
  map to a locator assertion.
- `expect` comes from `@opice/harness` (Playwright's web-first `expect`), not
  `bun:test` — import it from the harness. It also has the generic matchers
  (`toBe`, `toEqual`) for non-locator assertions.
- One top-level `test('walkthrough', ...)` keeps all steps in order in a
  single Bun test. If a step fails, the rest are skipped — what we want.
- **Always pass the per-test timeout** (the `60_000` third arg). bun defaults
  to 5s, but a real browser walk (first page load, async data, a dev server
  compiling on the first request) blows past 5s. Each retrying assertion still
  bounds itself; this just lifts the outer cap.
- Use a bare word in `el('foo')` for `data-testid`; `el('main h1')` (CSS chars)
  for a raw selector. `byRole`/`byLabel` for accessible roles/labels.
- A repo's user-land verb is callable in the test: `import { fullEnum } from
  '../browser-tools'` then `await call(fullEnum, { … })` (typed against its
  schema) — the same verb you used while walking.
- Wrap each scenario step in `await step('description', async () => {...})` —
  the harness reporter captures duration + screenshot per step.
- **Source backlink:** the harness auto-captures the test file path and derives
  the sibling `*.scenario.md` (replacing `.test.ts`). As long as the test and
  scenario sit side by side with matching names, the platform links a failed
  scenario back to both files automatically. If they don't match, pass the path
  explicitly: `browserTest('…', () => {…}, { hash: '…', scenarioFile: '…' })`.

### Parallel runs

When dispatched by an `opice-author` agent (batch authoring), you'll be handed a
unique browser session name like `opice-author-3`. Pass it as `--session
<name>` on **every** `opice-browser` call (or export `OPICE_BROWSER_SESSION`
once) so concurrent authors each drive their own browser. One scenario per
agent. Run `opice-browser --session <name> quit` when done.

### 5. Run and verify

Iterate on pass/fail with the plain runner (fast, no reporting):

```bash
bun test <generated.test.ts>
```

If it fails — open the test file, look at the failure, propose a fix
(usually selector or timing). Iterate until it passes or the user decides
to stop.

Once it passes, do **one** run through the reporter and confirm the run
actually reached the dashboard — a green test is not proof of ingest:

```bash
opice test <generated.test.ts>
```

It must print `[opice] View run: <url>`. If you instead see no such line, or a
`[opice] reporter could not reach the platform …` warning, the test passed but
**nothing was recorded** — stop and fix reporting before calling it done.
The usual cause is the host project's test setup (bunfig `[test].preload`,
vitest/jest `setupFiles`) installing a DOM (happy-dom/jsdom) or mocking `fetch`,
which blocks the reporter's cross-origin POST; scope that setup so it skips the
browser e2e dir. (Also check `OPICE_DSN` is set and the api key is valid.)

Then show the user the diff and ask if they want to commit.

### 6. Commit (only when asked)

When the user says commit / git / save:

```bash
git add <scenario.md> <test.ts> && git commit -m "tests: add <scenario-name> browser scenario"
```

Atomic add+commit per their global rules. Never `git add -A`.

## Edge cases

- **Multiple matches (strict mode)**: a Locator that matches >1 element throws
  on action. Narrow it — `el(\`${tid('datagrid')} ${tid('row-0')}\`)`, or
  `byRole('button', 'Save').first()` when you genuinely mean the first.
- **Popovers / dialogs**: `await expect(byRole('dialog')).toBeVisible()` after
  clicking the trigger, then interact with content inside.
- **Async data**: prefer a retrying `await expect(el(x)).toHaveText(...)` on a
  stable marker over fixed `await wait(ms)`.
- **No `data-testid` anywhere**: `byRole`/`byLabel` are reliable now, so prefer
  them over CSS; still suggest the user add test-ids for the most brittle spots.

## Files in this skill

- `SKILL.md` — this file
- `scenario-template.md` — copy as a starting point for new scenarios
- `test-template.ts` — reference shape of the generated test file
