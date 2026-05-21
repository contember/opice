# @opice/harness

Runtime primitives for [opice](../../README.md) — AI-driven E2E browser tests on top of [`agent-browser`](https://github.com/.../agent-browser).

## Install

```bash
bun add -D @opice/harness
```

Requires `agent-browser` on `PATH` and a Bun test runner.

## Usage

```ts
import { test, expect, describe } from 'bun:test'
import { browserTest, el, tid, waitFor, step } from '@opice/harness'

browserTest('DataGrid', () => {
  test('renders table structure', () => {
    waitFor(() => el(tid('datagrid-table')).exists)
    expect(el(tid('datagrid-header')).exists).toBe(true)
  })

  test('clicking a row highlights it', () => {
    step('user clicks first row', () => {
      el(tid('datagrid-row-0')).click()
    })
    waitFor(() => el(`${tid('datagrid-row-0')}[data-highlighted]`).exists)
  })
}, { hash: 'datagrid' })
```

## API

### Element handles

- `el(selector)` — returns an `ElementHandle`. Plain test-ids are auto-wrapped: `el('foo')` ≡ `el('[data-testid="foo"]')`.
- `tid(id)` — build a `[data-testid="..."]` selector string for compound selectors.

`ElementHandle` properties:

- `.exists`, `.text`, `.value`, `.isDisabled`, `.attr(name)`, `.count()`
- `.click()`, `.fill(value)`, `.select(optionText)`, `.focus()`, `.hover()`, `.press(key)`

Each action call auto-scrolls into view and sleeps 500ms to let the UI settle.
`.press(key)` focuses first, then sends the key (`Enter`, `Tab`, `Control+a`).

### Accessible-name selectors

For apps you can't annotate with `data-testid` (third-party UIs, generated form
ids). These wrap agent-browser's `find` locators, so a test reads the same way
the authoring dry-run drives the page (`byRole('button','Save').click()` ⇄
`agent-browser find role button click --name 'Save'`). Each returns an
`ElementHandle`.

- `byRole(role, name?)` — by ARIA role, optionally filtered by accessible name.
- `byLabel(text)` — a form control by its `<label>` (resolved via `for`/nesting).
- `byText(text)` — a leaf element by its visible text.

Actions go through `find`; queries (`.exists`, `.text`, …) and the focus/press
path fall back to a small `eval`. Prefer `data-testid` + `el()` when you own the
markup.

### Navigation

- `open(url)`, `reload()`, `back()`, `forward()` — page navigation. Use
  `reload()` after writing auth to localStorage/cookies (an `eval`-triggered
  reload is dropped by agent-browser).
- `currentUrl()`, `currentPath()` — read `location.href` / `location.pathname`.

### Waiting

- `waitFor(condition, opts?)` — polls until the predicate is true; throws on timeout. Default 10s timeout, 200ms interval.
- `wait(ms)` — fixed sleep. Avoid when `waitFor` works.

### Scenarios

- `browserTest(name, fn, options?)` — top-level scenario. Opens a fresh agent-browser session in `beforeAll`, closes in `afterAll`. Pass `{ hash: 'foo' }` for `PLAYGROUND_URL#foo`, or just a string shorthand: `browserTest(name, fn, 'foo')`.
- `step(name, fn)` — reportable step inside a scenario. Captures duration + screenshot. Reporter is a no-op until the opice platform is wired up.

### Misc

- `screenshot(path?)` — saves a PNG, returns the path. Default path under `/tmp/`.
- `evalJs(js)` — `agent-browser eval` passthrough.

## Configuration

- `PLAYGROUND_URL` — base URL for `browserTest` (default `http://localhost:15180`).
- `OPICE_ENDPOINT`, `OPICE_PROJECT`, `OPICE_API_KEY` — reporter config (or a single `OPICE_DSN`).
- `OPICE_REPORT` — `auto` (default: report only in CI), `always` (report locally too), or
  `never`. Outside CI, reporting is opt-in so iterating with bare `bun test` doesn't stream
  half-finished runs onto the shared dashboard. CI-detected runs are tagged `ci`, opted-in
  local runs `local`.
