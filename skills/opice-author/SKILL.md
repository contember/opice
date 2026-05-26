---
name: opice-author
description: >
  Phase 2 of opice authoring: fill in a skeleton `*.test.ts` (written by
  opice-plan) by walking the running app via opice-browser (a stateful
  Playwright browser), turning each pending `step(name, { intent, hint })`
  stub into an executable step with real selectors, promoting `invariant.todo`
  to enforced invariants, and verifying it passes by running `bun test`.

  Trigger when the user says "/opice-author <file>", "write an opice test
  for this skeleton", "author this opice scenario", or hands you a skeleton
  `*.test.ts` (or a `*.scenario.md`) and asks for a test.
allowed-tools: Bash(opice-browser:*), Bash(bun:*), Bash(opice:*), Bash(git:*), Read, Edit, Write, Glob, Grep
---

# opice-author — fill the skeleton (phase 2)

This skill turns a **phase-1 skeleton** (see `opice-plan`) into a working
`@opice/harness` test by actually driving the app in a real browser, recording
the selectors that worked, and filling in each pending step **in place** — the
skeleton file and the final test are the same file.

A skeleton looks like this: a real `*.test.ts` with metadata-first
`browserTest`, pending `step(name, { intent, hint })` stubs (no body yet), and
`invariant.todo(...)` acceptances. Your job is to fill the bodies and promote
the invariants, **without rewriting the intent** — the `intent` is the spec your
body is checked against. (If you're handed an old `*.scenario.md` instead, first
write a skeleton from it per `opice-plan`, then author that.)

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
   uniquely-identified thing** instead — `el(...)` *contains* the specific
   name/id your scenario is about.

2. **Stamp anything you create with a unique per-run marker.** A scenario that
   creates an entity must fill its name (or another searchable field) with a
   value unique to this run — e.g. `Opice <flow> ${Date.now()}` — and assert on
   *that exact string*. Each run then asserts on its own artifact, never
   collides with leftovers, and the rows stay sweepable later. Never reuse a
   fixed name for created data.

3. **Deep-link to the surface under test; auth is a precondition, not a step.**
   The skeleton's `url` is already the deepest stable route. Don't author a
   login/navigation preamble into scenarios that aren't *about* login — if the
   app authenticates ambiently (dev session token, injected state),
   deep-linking lands you already authenticated. Only start at `/` when the auth
   transition itself is the subject.

4. **Read the suite's context/invariants file before authoring.** If the
   directory has an ambient-context file — e.g. `tests/browser/invariants.md` —
   read it first. It holds app-wide truths (auth model, base URLs, selector
   strategy, first-load timeouts, available seeds, known overlays) so individual
   scenarios stay short. Apply those invariants even when a skeleton doesn't
   restate them.

5. **Fixtures must coexist.** If the metadata declares `seeds`, they must be
   idempotent and keyed by stable ids so they compose with every other seed
   already in the DB. Don't author against a seed that fights another for the
   same row.

## Inputs

- **skeleton file**: a path to a `*.test.ts` with pending steps — the user will
  give you this (or you find it via Glob). The metadata (`url`, `seeds`,
  `roles`, …), step `intent`/`hint`s, and `invariant.todo`s are all there.
- **playground URL**: read it from the skeleton's `url` metadata. If absent,
  check `PLAYGROUND_URL` env, then ask.

## Workflow

### 1. Read the skeleton

Parse the file:

- **metadata** (first arg of `browserTest`): `name`, `url`, `hash`, `feature`,
  `seeds`, `roles` — these stay as-is.
- **pending steps**: each `await step('<name>', { intent, hint })`. The `name`
  and `intent` are the durable spec — **keep them verbatim**. The `hint` tells
  you what to do; you'll consume and drop it.
- **`invariant.todo('<name>', '<hint>')`**: acceptances to wire up.

Confirm the playground is reachable at the metadata `url` before walking.

### 2. Verify project setup

Run from the project root (where the skeleton lives or its closest ancestor
with a `package.json`).

```bash
grep -q '@opice/harness' package.json || grep -r '@opice/harness' packages/*/package.json 2>/dev/null
```

If not installed, stop and tell the user to add it.

### 3. Walk the scenario in opice-browser

`opice-browser` is a stateful Playwright browser: `launch` starts it (it
persists between calls), then each verb drives the live page. The verbs are the
**same vocabulary the test will use** — `byRole`/`byLabel`/`el` map 1:1 onto the
harness DSL, so the walk is a transcript of the steps you're about to fill in.

```bash
opice-browser launch <url-from-metadata>#<hash>
opice-browser aria-snapshot main      # the agent's view of the page (ARIA tree)
```

For each pending step, use its `hint` as the plan and resolve the real
interaction:

- **`aria-snapshot`** to see what's on the page (roles + accessible names) after
  a navigation or click.
- **Resolve a selector / locator**, in this preference order:
  1. `data-testid` if present — `opice-browser click <testid>` (a bare word is a
     test-id). In the test: `el('<testid>')`.
  2. An accessible role + name — `opice-browser byRole button click --name Save`.
     In the test: `byRole('button', 'Save')`. Reliable (real Playwright
     gestures), so reach for it freely when you don't own the markup.
  3. A `<label>` for form controls — `opice-browser byLabel Email fill --value …`
     → `byLabel('Email')`.
  4. Avoid index-based or class-only selectors — they break on UI changes.
- **Perform the action** (`click` / `fill` / `press`) and watch it land.
- **Verify the expectation** (`opice-browser text <sel>`, or re-snapshot) —
  measured against the step's `intent`, not just "something happened".
- Record the verb + selector you used. This is what goes into the step body.

For the `invariant.todo`s, figure out how to actually *enforce* the property
(e.g. capturing an API response, asserting a string is absent from the DOM).

If a domain flow needs a repeated multi-step gesture (e.g. a custom select
widget), check for a repo `browser-tools.ts` — `opice-browser commands` lists
any user-land verbs. Prefer a shared verb over hand-driving the sequence; the
test can call it too.

If a step's action can't be made to work live (element absent, the flow doesn't
behave as the `intent` claims), **don't fabricate a selector** — tell the user.
Distinguish a *test* problem (wrong selector) from an *app* problem (the intent
genuinely doesn't hold): the latter is a finding, not something to paper over.

When done walking, `opice-browser quit` to free the browser (the test run in
step 5 launches its own in-process browser — the daemon is authoring-only).

### 4. Fill in the skeleton

Edit the skeleton **in place**. For each pending step, turn

```ts
await step('extend the contract past its current end date', {
	intent: 'the new validUntil must be strictly later; persists + appends an immutable Prodloužení event',
	hint: 'open the Prodloužit dialog, set a later end date, confirm; assert the new date + a Prodloužení history row',
})
```

into

```ts
await step('extend the contract past its current end date', {
	intent: 'the new validUntil must be strictly later; persists + appends an immutable Prodloužení event',
}, async () => {
	await byRole('button', 'Prodloužit smlouvu').click()
	const dialog = getPage().getByRole('dialog', { name: 'Prodloužit smlouvu' })
	await dialog.locator('input[type=date]').fill('2026-08-01')
	await dialog.getByRole('button', { name: 'Prodloužit' }).click()
	await expect(/* the new Platnost do */).toContainText('1. srpna 2026', { timeout: 15_000 })
})
```

— **keep `name` and `intent`, drop `hint`**, fill the body. Promote each
`invariant.todo`:

```ts
// before
await invariant.todo('content API never returns the e-mail without a grant', 'capture /_api/content and assert it omits the e-mail')

// after — enforced
await invariant('content API never returns the e-mail without a grant', async () => {
	const bodies = await captureContentResponses(reload)
	expectContentDoesNotContain(bodies, REAL_EMAIL)
})

// or, if it genuinely can't hold yet (deferred to a ticket):
await invariant.fixme(
	'content API never returns the e-mail without a grant',
	'issue 018: server-side masking not wired — crmOperator reads the row unconditionally',
	async () => { /* the check, which is EXPECTED to fail today */ },
)
```

See `test-template.ts` for the full authored shape and `skeleton-template.ts`
for the phase-1 input.

Notes on the DSL:

- **The DSL is async.** `el`/`byRole`/`byLabel` return Playwright `Locator`s;
  every action and read is awaited, and each `step` call is awaited. Forgetting
  an `await` is the most common authoring bug.
- **Use retrying assertions, not manual polling.** `await expect(el(x))
  .toHaveText(...)` / `.toContainText(...)` / `.toBeVisible()` auto-wait and
  retry. Keep `await waitFor(async () => …)` only for predicates that don't map
  to a locator assertion.
- `expect` comes from `@opice/harness` (Playwright's web-first `expect`), not
  `bun:test`. It also has the generic matchers (`toBe`, `toEqual`).
- One top-level `test('walkthrough', ...)` keeps all steps in order in a single
  Bun test. If a step fails, the rest are skipped — what we want.
- **Keep the per-test timeout** (the `60_000` third arg of `test`). bun defaults
  to 5s; a real browser walk blows past that. Each retrying assertion still
  bounds itself; this just lifts the outer cap.
- `el('foo')` = `data-testid`; `el('main h1')` (CSS chars) = raw selector.
  `byRole`/`byLabel` for accessible roles/labels.
- A repo's user-land verb is callable: `import { fullEnum } from
  '../browser-tools'` then `await call(fullEnum, { … })`.
- **No separate source file.** The test is its own spec — the `intent`s and
  invariants ARE the human-readable scenario, so there's no `.scenario.md` to
  keep in sync. The harness auto-captures the test file path for the dashboard
  backlink.

### Parallel runs

When dispatched by an `opice-author` agent (batch authoring), you'll be handed a
unique browser session name like `opice-author-3`. Pass it as `--session
<name>` on **every** `opice-browser` call (or export `OPICE_BROWSER_SESSION`
once) so concurrent authors each drive their own browser. One scenario per
agent. Run `opice-browser --session <name> quit` when done.

### 5. Run and verify

Iterate on pass/fail with the plain runner (fast, no reporting):

```bash
bun test <the-test>.test.ts
```

It passes only when **no step is pending** (the "N pending step(s)" warning is
gone) and every filled step + promoted invariant is green. If it fails, open the
file, look at the failure, fix it (usually selector or timing), and iterate.
Never rewrite a step's `intent` (or an invariant's name) to match a wrong body —
fix the body, or flag the app bug.

Once it passes, do **one** run through the reporter and confirm the run actually
reached the dashboard — a green test is not proof of ingest:

```bash
opice test <the-test>.test.ts
```

It must print `[opice] View run: <url>`. If you instead see no such line, or a
`[opice] reporter could not reach the platform …` warning, the test passed but
**nothing was recorded** — stop and fix reporting before calling it done. The
usual cause is the host project's test setup (bunfig `[test].preload`,
vitest/jest `setupFiles`) installing a DOM (happy-dom/jsdom) or mocking `fetch`,
which blocks the reporter's cross-origin POST; scope that setup so it skips the
browser e2e dir. (Also check `OPICE_DSN` is set and the api key is valid.)

Then show the user the diff and ask if they want to commit.

### 6. Commit (only when asked)

When the user says commit / git / save:

```bash
git add <the-test>.test.ts && git commit -m "tests: author <scenario-name> browser scenario"
```

Atomic add+commit per their global rules. Never `git add -A`.

## Edge cases

- **Multiple matches (strict mode)**: a Locator that matches >1 element throws
  on action. Narrow it — `el(\`${tid('datagrid')} ${tid('row-0')}\`)`, or
  `byRole('button', 'Save').first()` when you genuinely mean the first.
- **Popovers / dialogs**: `await expect(byRole('dialog')).toBeVisible()` after
  clicking the trigger, then interact with content inside.
- **Keyboard-opened popovers (Radix enum/select)**: the launched session holds
  one connection for its whole life, so a popover opened with `press` stays open
  for the next command's option click — drive it step by step. For a *repeated*
  domain gesture, factor it into a compound `browser-tools.ts` verb (e.g.
  `selectEnumOption`) the test calls too, keeping authoring and test identical.
- **Async data**: prefer a retrying `await expect(el(x)).toHaveText(...)` on a
  stable marker over fixed `await wait(ms)`.
- **No `data-testid` anywhere**: `byRole`/`byLabel` are reliable, so prefer them
  over CSS; still suggest the user add test-ids for the most brittle spots.
- **Actions that trigger an async write** (autosave, optimistic UI, a mutation
  on select): doing several back-to-back races — an in-flight write re-renders
  the list and **detaches the element you're about to click**, so the next
  action times out on a "visible, enabled, stable" element. After each such
  step, **assert the result landed** (`await expect(byText(thatItem))
  .toBeVisible()`) before the next one; the retrying assertion waits out the
  write + re-render. Don't paper over it with `wait(ms)`.
- **SSR / hydrated apps (Next.js, etc.)**: filling a form right after `open()`
  can set the DOM value but **miss the framework's state** — the `onChange`
  handlers attach during hydration, so the form submits empty and the page
  doesn't advance. `await getPage().waitForLoadState('networkidle')` before
  interacting, and prefer `pressSequentially` over `fill` for the inputs.
- **A write "won't save" with no visible error**: optimistic UIs often show the
  change and swallow a server-side rejection (e.g. an ACL/validation error rolls
  the mutation back; it's gone on reload, no toast). Don't assume a selector
  bug — instrument the request in `opice-browser`: `eval` a `window.fetch`
  wrapper that logs the API response body, and read the real error there. This
  is the fastest way to tell a test problem from an app bug.
- **An invariant that can't hold yet**: if walking proves an acceptance
  genuinely fails (e.g. a security property the app hasn't implemented), don't
  silently drop it or weaken the `intent`. Wire it as `invariant.fixme(name,
  reason, fn)` with the body that's *expected to fail* and a `reason` linking the
  ticket. It surfaces as an amber warning and starts passing (flagged
  `fixmepass`) once the app is fixed — drop `.fixme` then.
- **A `step.blocked` / `invariant.blocked` stub**: the planner marked this as
  "feature not built". Check whether it's been built since. If yes, author it
  like any other stub. If not, **leave it blocked** — don't fabricate a body for
  a feature that doesn't exist. Conversely, if you discover while walking that a
  plain pending step *can't* be authored because the feature is missing, convert
  it to `step.blocked(name, reason, { intent })` rather than forcing a fake
  assertion — that keeps the dashboard honest about what's waiting on the app.
- **Cross-origin flows** (the scenario spans two hosts, e.g. an app + a public
  site): one browser context spans both, but auth usually doesn't — a
  localStorage/injected token for host A won't carry to host B, which may use
  its own cookie login. Do B's login through its real UI, and **probe
  reachability from the test process** (`await fetch(otherBase)`), not the page
  (cross-origin), so you can guard/skip the second-host steps when it's down.

## Files in this skill

- `SKILL.md` — this file
- `skeleton-template.ts` — the phase-1 input shape (what opice-plan writes)
- `test-template.ts` — the phase-2 authored shape (what you produce)
