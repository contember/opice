---
name: opice-author
description: >
  Author an opice E2E browser test from a human-readable scenario file.
  Takes a `*.scenario.md`, walks the running app via agent-browser, picks
  selectors (preferring `data-testid`), generates a `*.test.ts` using
  `@opice/harness`, and verifies it passes by running `bun test`.

  Trigger when the user says "/opice-author <file>", "write an opice test
  for this scenario", "generate opice test from <md file>", or hands you a
  *.scenario.md and asks for a test.
allowed-tools: Bash(agent-browser:*), Bash(bun:*), Bash(git:*), Read, Edit, Write, Glob, Grep
---

# opice-author — scenario → test

This skill turns a human-readable scenario into a working `@opice/harness`
test by actually driving the app in a real browser, recording the
selectors that worked, and then writing a test that uses those same
selectors.

It does **NOT** commit unless the user explicitly asks (per their global
git rules).

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

### 3. Walk the scenario in agent-browser

Use a fresh session so it doesn't collide with anything else:

```bash
agent-browser --session opice-author-$$ open <URL>#<Hash>
agent-browser --session opice-author-$$ snapshot -i
```

For each step:

- **Snapshot** when you need fresh element refs (after a click or
  navigation).
- **Resolve a selector**, in this preference order:
  1. `data-testid` if the element has one — `[data-testid="..."]`
  2. A stable attribute or role from the a11y tree
     (`button[aria-label="Save"]`, `[role="dialog"] input`)
  3. Avoid index-based or class-only selectors — they break on UI changes.
- **Perform the action** (click / fill / select).
- **Verify the expectation** before moving on.
- Record the selector you used. This is what goes into the generated test.

If a step's expectation fails even though the action visibly worked,
re-snapshot — you may have picked a brittle selector. Try a more stable
one.

If a step's action fails (element not present), tell the user. Don't
fabricate selectors in the generated test that you couldn't make work
live — that's the whole point of this skill.

### 4. Generate the test file

Use this template (see `test-template.ts` for the full version):

```ts
import { test, expect, describe } from 'bun:test'
import { browserTest, el, tid, waitFor, step } from '@opice/harness'

browserTest('<Scenario Title>', () => {
	test('walkthrough', () => {
		step('<step 1 description>', () => {
			waitFor(() => el(tid('<test-id>')).exists)
			expect(el(tid('<test-id>')).text).toContain('<text>')
		})

		step('<step 2 description>', () => {
			el(tid('<button-id>')).click()
			waitFor(() => el(tid('<expected>')).exists)
		})
	}, 60_000)
}, '<hash>')
```

Notes:

- One top-level `test('walkthrough', ...)` keeps all steps in order in a
  single Bun test. If a step fails, the rest are skipped — what we want.
- **Always pass the per-test timeout** (the `60_000` third arg). bun defaults
  to 5s, but `waitFor` blocks synchronously and a real browser walk (first page
  load, async data, a dev server compiling on the first request) blows past 5s
  — you'd get a misleading `timed out after 5000ms` even though the assertions
  are fine. Each `waitFor` still bounds itself; this just lifts the outer cap.
- Use `tid('foo')` for `data-testid` selectors. Use raw selectors only
  when there's no testid.
- Wrap each scenario step in `step('description', () => {...})` —
  the harness reporter captures duration + screenshot per step.
- `waitFor` instead of fixed sleeps wherever the UI changes async.
- **Source backlink:** the harness auto-captures the test file path and derives
  the sibling `*.scenario.md` (replacing `.test.ts`). As long as the test and
  scenario sit side by side with matching names, the platform links a failed
  scenario back to both files automatically. If they don't match, pass the path
  explicitly: `browserTest('…', () => {…}, { hash: '…', scenarioFile: '…' })`.

### Parallel runs

When dispatched by an `opice-author` agent (batch authoring), you'll be handed a
unique browser session name like `opice-author-3`. Use it for **every**
`agent-browser` call instead of `opice-author-$$` so concurrent authors don't
share a browser. One scenario per agent.

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

- **Multiple `data-testid`s collide**: namespace via parent selector — see
  `bindx/tests/browser/dataGrid.test.ts` for the `const scope = tid('datagrid-example')`
  pattern, then `el(\`${scope} ${tid('row-0')}\`)`.
- **Popovers / dialogs**: most use `role="dialog"`. After clicking the
  trigger, `waitFor(() => el('[role="dialog"]').exists)` before
  interacting with content inside.
- **Async data**: prefer `waitFor` on a stable marker (e.g. a specific row
  text) rather than fixed `wait(ms)`.
- **No `data-testid` anywhere**: tell the user this will be brittle and
  recommend adding testids first. Generate the test anyway with
  best-effort selectors.

## Files in this skill

- `SKILL.md` — this file
- `scenario-template.md` — copy as a starting point for new scenarios
- `test-template.ts` — reference shape of the generated test file
