# Design: pivot the browser layer from agent-browser to Playwright

**Status:** proposal, for review.
**Author:** drafted with Claude.
**Scope:** the opice *test product* — `@opice/harness`, `@opice/cli`, the
authoring skills. The platform (worker + dashboard + reporter protocol) is
**unchanged**.

---

## 1. Why

opice is built on the third-party [`agent-browser`](https://github.com/) Rust
CLI. The harness shells out to it for every primitive — in tests **and** in CI.
That choice has two structural costs we keep paying:

### 1.1 Reliability

agent-browser drives Chrome over CDP with its own action implementations. They
don't always behave like a real user gesture:

- **`find … click` doesn't fire a bindx/React submit** — proven by isolation
  on a real app: holding the fill constant, an `el`-style click (scroll-into-view
  + real click + settle) creates the record and navigates; `agent-browser find
  role button click --name 'Vytvořit'` is a no-op on the same enabled button.
- **`find focus` errors** ("Unknown subaction: focus") in 0.23.4.
- A reload triggered from inside `eval('location.reload()')` is silently
  dropped (the eval context is torn down before navigation commits).

We can't fix these — agent-browser is third-party Rust. We work around them
(stamp + `el()` click, CLI reload, focus+Enter for Radix), and each workaround
is a hack we own and must explain.

### 1.2 Vocabulary divergence (the bigger problem)

The authoring agent **explores** the app through `agent-browser` (CSS selectors,
`snapshot`, refs). The test it **writes** uses the harness API (`el`, `tid`,
`byRole`). Because agent-browser is CSS-only and can't do accessible-name
selectors or reliable React clicks, the harness has to bridge the gap with
in-page `eval` resolvers and stamping. So:

- what the agent *does* during the dry-run ≠ what it *writes* in the test, and
- every gap we patch in the harness widens that distance.

`agent-browser` does expose a `find role|label|text … <action>` command, which
looked like it would unify the two — but (a) it only does actions, not queries,
and (b) its click is unreliable (§1.1). So the unification doesn't hold.

### 1.3 No user-land extensibility

Domain apps need domain verbs. A bindx `SelectEnumField` is "focus the trigger,
press Enter, click the option button". Today that lives as `selectEnumOption`
**in the test repo only** — the authoring agent doesn't know it and drives the
raw sequence by hand. There's no way for a repo to teach **both** the agent and
the tests one shared verb.

---

## 2. Goals / non-goals

**Goals**

1. One browser engine with real-user-gesture fidelity → delete the hack class.
2. **Zero authoring/test divergence**: the agent explores and the test runs
   through the *same* command vocabulary and the *same* implementation.
3. **User-land commands**: a repo defines verbs once (`browser-tools.ts`) and
   both the authoring agent and the tests use them.
4. Keep the opice value props intact: `*.scenario.md` → `*.test.ts` authoring,
   deterministic LLM-free CI runs, centralized reporting.

**Non-goals (unchanged from v1)**

- No visual-regression, no browser farm, no multi-tenant platform changes.
- No LLM in CI.
- The reporter wire protocol and the dashboard stay as-is.

---

## 3. Proposed architecture

Playwright becomes the engine. Two faces over one shared core:

```
        ┌─────────────────────── shared command registry ───────────────────────┐
        │  built-in verbs (open, click, fill, byRole, ariaSnapshot, …)           │
        │  + user-land verbs loaded from <repo>/browser-tools.ts (fullEnum, …)   │
        │  each: (ctx: { page, ... }, args) => result   (+ Zod param schema)     │
        └───────────────┬───────────────────────────────────────┬───────────────┘
                        │                                         │
        TEST FACE (in-process)                       AUTHORING FACE (stateful)
        @opice/harness                               opice-browser daemon
        - bun test, Playwright in-process            - holds a live browser/page
        - el()/byRole()/byLabel() → Playwright       - thin CLI client + / or MCP
          locators                                     server transport
        - custom verbs imported directly             - exposes same registry to
        - no CLI, no daemon in CI                       the agent + ariaSnapshot
```

### 3.1 Tests = harness over Playwright, in-process

`browserTest`'s `beforeAll` launches Playwright (`chromium.launch()`), opens a
page, navigates to `PLAYGROUND_URL`; `afterAll` closes. **No CLI, no
agent-browser in CI** — `bun test` drives Playwright directly. This alone:

- fixes reliability (Playwright actionability: auto-wait, real clicks that fire
  React handlers, proper `fill` events),
- removes the `exec('agent-browser …')` shell-out per primitive,
- gives native `getByRole` / `getByLabel` / `getByText` / `getByPlaceholder`,
  web-first retrying assertions, `locator.ariaSnapshot()`, tracing.

API mapping (keep the existing surface, re-back it):

| harness today                       | Playwright backing                                   |
| ----------------------------------- | ---------------------------------------------------- |
| `el('foo')` / `el(tid('foo'))`      | `page.getByTestId('foo')` / `page.locator(css)`      |
| `el(css).click()/.fill()/.text`     | `locator.click()/.fill()/.textContent()`             |
| `byRole('button','X')`              | `page.getByRole('button', { name: 'X' })`            |
| `byLabel('Email')`                  | `page.getByLabel('Email')`                           |
| `byText('Saved')`                   | `page.getByText('Saved')`                            |
| `waitFor(cond)`                     | prefer Playwright `expect(locator).toBeVisible()` etc; keep `waitFor` for arbitrary predicates |
| `evalJs(js)`                        | `page.evaluate(js)`                                  |
| `reload()/open()/back()`            | `page.reload()/goto()/goBack()`                      |
| `el().focus()/.hover()/.press()`    | `locator.focus()/.hover()/.press()`                  |

`el`/`tid` stay (test-id-first is still the default and Playwright has
`getByTestId`), so **existing tests keep working** with a re-backed harness.
`byRole`/`byLabel`/`byText` become native (drop the eval-stamp).

### 3.2 Authoring = stateful `opice-browser` over Playwright

Agentic authoring needs a browser that **persists between commands** (the agent
pokes step by step). That's the one piece we build. Two viable transports —
both backed by the same registry:

**(a) CLI over a persistent browser (CDP).** `opice-browser launch` starts
Chrome with a remote-debugging port and records the endpoint in a session file.
Each `opice-browser <verb> …` call does `chromium.connectOverCDP(endpoint)`,
grabs the existing page, runs the verb, disconnects. Statefulness lives in the
**browser process itself**, not a long-running Node daemon — so there's little
custom session machinery (this is essentially what agent-browser does in Rust).
Mirrors today's CLI ergonomics for skills/bash.

**(b) MCP server.** A long-running `opice-browser mcp` server holds the
Playwright `page` and exposes the registry as MCP tools (+ an `aria_snapshot`
tool). Claude Code consumes MCP natively — no shell parsing, structured
args/results, and statefulness is intrinsic (the server holds the page). User
verbs from `browser-tools.ts` register as additional MCP tools.

> Recommendation: ship **(a)** first (closest to today, skills already shell to
> a CLI), design the registry transport-agnostic so **(b)** is an alternate
> front end later. `connectOverCDP` keeps (a) cheap.
>
> **Shipped:** a hybrid of (a) and (b). The CLI surface and `connectOverCDP` are
> from (a), but `launch` runs a long-running server that **holds one connection
> + page** (the statefulness of (b)) and serves verbs over a unix socket; verb
> commands are thin socket clients. Pure per-call connect/disconnect was tried
> and dropped because the disconnect blurs the page — a keyboard-opened Radix
> popover closes between two commands (see §7). Holding the connection (plus
> enabling focus emulation on the connected page) makes the daemon behave like
> the held page in a test. MCP can still be added as another front end over the
> same server.

For the agent's "what's on screen" need, expose `locator.ariaSnapshot()` (YAML
a11y tree) — purpose-built for agents and assertions. This replaces
agent-browser's `snapshot`/refs.

### 3.3 The shared command registry + user-land plugins

A command is a name + Zod param schema + an impl over a context:

```ts
// @opice/harness — definition primitive
export const command = <S extends z.ZodType>(name: string, params: S,
  run: (ctx: CommandCtx, args: z.infer<S>) => Promise<unknown>) => ({ name, params, run })

// CommandCtx = { page: Page, byRole, byLabel, … }  // Playwright page + helpers
```

A repo drops `browser-tools.ts` at its root:

```ts
import { command, z } from '@opice/harness'

export const fullEnum = command('fullEnum',
  z.object({ label: z.string(), option: z.string() }),
  async ({ page }, { label, option }) => {
    await page.getByLabel(label).press('Enter')          // open Radix popover
    await page.getByRole('button', { name: option }).click()
  })
```

- **Authoring**: the daemon/MCP auto-loads `browser-tools.ts` and exposes
  `fullEnum` to the agent (`opice-browser fullEnum --label Typ --option "…"` or
  as an MCP tool). The agent discovers it via `opice-browser commands` / tool
  list.
- **Tests**: the harness loads the same module; the test calls
  `fullEnum({ label: 'Typ', option: '…' })` (or `await tools.fullEnum(...)`).
  One implementation, one place — bindx knowledge stops being duplicated.

This is the core unification: built-in and custom verbs are the **same objects**
on both faces.

### 3.4 Reporter

In-process tests can call the reporter directly (no `$TMPDIR` handoff files, no
post-`bun test` finalize dance) — the harness owns the full scenario lifecycle
in one process. Keep the wire protocol identical so the dashboard is untouched.
`opice test` slims to: set `OPICE_*` env, run `bun test`, done.

---

## 4. Authoring flow (new)

1. `opice-browser launch` (or MCP server up); agent opens the app.
2. Agent explores with the **registry verbs** + `aria_snapshot` — the exact
   verbs the test will use. Custom verbs from `browser-tools.ts` are available.
3. Agent writes `*.test.ts` using `byRole/byLabel/el/tid` + custom verbs — a
   1:1 transcript of what it just did.
4. `bun test` (in-process Playwright) verifies green; commit.

`opice-author` SKILL changes: `allowed-tools` swaps `Bash(agent-browser:*)` →
`Bash(opice-browser:*)` (or the MCP server); selector guidance shifts from
"prefer data-testid via agent-browser snapshot" to "use registry verbs;
`getByRole`/`getByLabel` first, `data-testid` when you own the markup".

---

## 5. CI changes

- Install Playwright browsers (`bunx playwright install chromium`) instead of
  `agent-browser install`.
- `opice test` → `bun test` runs Playwright in-process. No `opice-browser`
  daemon in CI (the daemon is an authoring-only convenience).
- Everything else (seed, reporter env) unchanged.

---

## 6. Migration plan (phased, each shippable)

- **Phase 0 — spike (de-risk):** persistent-browser statefulness via
  `connectOverCDP` across separate CLI invocations; confirm `getByRole`/click
  fire React handlers; confirm `ariaSnapshot` is good enough for the agent.
- **Phase 1 — harness over Playwright (in-process):** re-back `el/tid/waitFor/
  evalJs/screenshot/byRole/byLabel/byText/navigation/ElementHandle` on
  Playwright. Keep the public API identical. Run the existing self-test +
  consumer suites green on both engines if feasible (feature-flag the backend
  during transition). Biggest single win; low risk.
- **Phase 2 — `opice-browser` daemon + CLI:** registry, built-in verbs,
  `aria_snapshot`, session file. (MCP transport optional, later.)
- **Phase 3 — user-land `browser-tools.ts`:** loader + `command()` primitive,
  surfaced to both faces.
- **Phase 4 — skills + CI + cleanup:** update `opice-author`/`opice-batch`/
  `opice-reeval` to the new driver; switch CI; deprecate agent-browser; update
  README architecture/non-goals.

**Existing tests:** `el`/`tid` keep working (just re-backed), so consumer
repos migrate lazily; `byRole`/`byLabel` improve silently.

---

## 7. Risks & open questions

- **`connectOverCDP` limits:** some Playwright features assume a
  Playwright-launched browser. Verify click/fill/getByRole/ariaSnapshot/file-
  upload/downloads behave under CDP-connect (Phase 0).
- **Persistent state across CLI calls:** grabbing "the current page" each call
  (tabs, popups, navigation in flight) needs clear rules. MCP transport sidesteps
  this by holding the page in one server process — may be worth doing first.
  - *Observed, then resolved:* per-command connect/disconnect dropped transient
    page state — a **keyboard-opened Radix popover** blurred and closed between a
    `byRole … press` and the follow-up option click (the disconnect blurs the
    page; headless focus is not emulated on a `connectOverCDP`-attached page).
    **Fix (shipped):** `launch` holds one connection + page in a long-running
    server (§3.2) and enables `Emulation.setFocusEmulationEnabled` on it, so the
    popover survives across separate verb commands — verified. Tests were never
    affected (the in-process page holds one connection per scenario).
- **Per-scenario isolation in CI:** in-process, give each `browserTest` its own
  `context` (clean cookies/storage) — cheap with Playwright.
- **Bun + Playwright:** Playwright is Node-oriented; confirm it runs clean under
  `bun test` (it generally does; watch for `playwright` internal Node APIs).
- **`waitFor(() => bool)` API:** keep for arbitrary predicates, but steer
  authors toward retrying `expect(locator)` assertions to cut flakiness.
- **Effort vs. today-works:** this is a foundational rebuild; the current stack
  is green. Phase 1 alone (in-process harness) may capture most of the value;
  the daemon (Phases 2–3) is where the real new build is.

---

## 8. Recommendation

Pivot. The reliability and divergence problems are properties of building on a
third-party CSS-only CLI, not bugs to file. Sequence by value/risk:

1. **Phase 1 (in-process Playwright harness)** — do this regardless; it removes
   the hack class and most divergence, low risk, existing API preserved.
2. **Phases 2–3 (stateful `opice-browser` + registry + user plugins)** — the
   part that fully closes authoring↔test divergence and unlocks `fullEnum`-style
   verbs. Spike statefulness (Phase 0) before committing.

Decision needed: approve Phases 0–1 to start, and pick the authoring transport
(CLI-over-CDP first vs. MCP-first) for Phases 2–3.
