# @opice/harness

Runtime primitives for [opice](../../README.md) — AI-driven E2E browser tests on
top of [Playwright](https://playwright.dev). The browser runs **in-process**
under `bun test`; there is no CLI or daemon in the test path.

## Install

```bash
bun add -D @opice/harness
bunx playwright install chromium
```

Runs under the Bun test runner.

## Usage

```ts
import { test, describe } from 'bun:test'
import { browserTest, el, byRole, byLabel, step, expect } from '@opice/harness'

browserTest({ name: 'DataGrid', hash: 'datagrid' }, () => {
  test('renders and is interactive', async () => {
    await step('table is visible', async () => {
      await expect(el('datagrid-table')).toBeVisible()
    })

    await step('clicking a row highlights it', async () => {
      await el('datagrid-row-0').click()
      await expect(el('datagrid-row-0')).toHaveAttribute('data-highlighted', '')
    })
  }, 60_000)
})
```

The DSL is **async** and returns Playwright `Locator`s, so the full Locator API
(`.click()`, `.fill()`, `.textContent()`, `.first()`, …) and the web-first
`expect(locator)` assertions are available. `expect` is re-exported from the
harness (Playwright's `expect`, which works under `bun:test`).

## API

### Locators

- `el(selector)` — a `Locator`. A bare word is a test-id (`el('foo')` ≡
  `getByTestId('foo')`, matching `data-testid`); anything with CSS-flavoured
  characters is a raw CSS selector (`el('main h1')`).
- `tid(id)` — build a `[data-testid="..."]` selector string for composing into a
  larger CSS selector: `el(`${tid('row')} button`)`.

### Accessible-name selectors

Native Playwright accessibility locators — reliable, real user gestures. Prefer
these (or `data-testid`) over CSS.

- `byRole(role, name?)` — by ARIA role, optionally filtered by accessible name.
- `byLabel(text)` — a form control by its `<label>` / `aria-label`.
- `byText(text)` — by visible text.

### Assertions

- `expect(locator)` — Playwright's web-first, auto-retrying assertions:
  `.toBeVisible()`, `.toHaveText()`, `.toContainText()`, `.toBeEnabled()`,
  `.toHaveAttribute()`, … Prefer these over manual polling. Generic matchers
  (`.toBe`, `.toEqual`) work too.

### Navigation

- `open(url)`, `reload()`, `back()`, `forward()` — page navigation (each awaits
  the load event).
- `currentUrl()`, `currentPath()` — read `location.href` / `location.pathname`
  (synchronous).

### Waiting

- `waitFor(condition, opts?)` — polls a (possibly async) predicate until true;
  throws on timeout (default 10s / 200ms). For predicates that don't map to a
  retrying `expect` assertion.
- `wait(ms)` — fixed sleep. Avoid when `waitFor` or `expect` works.

### Scenarios

- `browserTest(name, fn, options?)` — top-level scenario. Launches a fresh
  isolated Playwright browser + context + page in `beforeAll`, navigates to the
  scenario URL, tears down in `afterAll`. Pass `{ hash: 'foo' }` for
  `PLAYGROUND_URL#foo`, or a string shorthand: `browserTest(name, fn, 'foo')`.
- `step(name, fn)` — reportable async step. `await step('…', async () => {…})`;
  captures duration + screenshot. Reporter is a no-op until the platform is wired.

### Custom verbs (user-land)

Define a domain verb once in `<repo>/browser-tools.ts` and use it in **both** the
authoring agent (`opice-browser`) and your tests:

```ts
// browser-tools.ts
import { command, z } from '@opice/harness'

export const fullEnum = command('fullEnum',
  z.object({ label: z.string(), option: z.string() }),
  async ({ page }, { label, option }) => {
    await page.getByLabel(label).press('Enter')
    await page.getByRole('button', { name: option }).click()
  })
```

```ts
// in a test
import { call } from '@opice/harness'
import { fullEnum } from '../browser-tools'
await call(fullEnum, { label: 'Typ', option: 'Faktura' })
```

### Context setup (user-land)

Export `setup(context)` from `<repo>/browser-setup.ts` to configure the browser
**context** once, **before the first navigation** — on both faces (the test
harness runs it in `beforeAll` before `page.goto`; the `opice-browser` server
runs it after connecting, before navigating to the launch URL). Because it runs
pre-navigation, an `addInitScript` here fires before the app's own scripts on
first paint — the place to seed storage/cookies, grant permissions, or set a
boot-time flag (e.g. "automated run — skip dev-only chrome"). Keep it
idempotent.

```ts
// browser-setup.ts
import type { BrowserSetup } from '@opice/harness'

export const setup: BrowserSetup = async (context) => {
  await context.addInitScript(() => {
    try { localStorage.setItem('app:e2e', '1') } catch {}
  })
}
```

### Misc

- `screenshot(path?)` — saves a PNG, returns the path (default under `/tmp/`).
- `evalJs(js)` — `page.evaluate` passthrough (returns the real JS value).
- `getPage()` / `getContext()` — the live Playwright `Page` / `BrowserContext`
  for an escape hatch into the raw API.

## Configuration

- `PLAYGROUND_URL` — base URL for `browserTest` (default `http://localhost:15180`).
- `OPICE_HEADED` (or `PWDEBUG`) — run headed for local debugging (default headless).
- `OPICE_ENDPOINT`, `OPICE_PROJECT`, `OPICE_API_KEY` — reporter config (or a single `OPICE_DSN`).
- `OPICE_REPORT` — `auto` (default: report only in CI), `always` (report locally too), or
  `never`. Outside CI, reporting is opt-in so iterating with bare `bun test` doesn't stream
  half-finished runs onto the shared dashboard. CI-detected runs are tagged `ci`, opted-in
  local runs `local`.
```
