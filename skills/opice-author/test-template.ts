import { browserTest, byLabel, byRole, el, expect, invariant, step, waitFor } from '@opice/harness'

/**
 * PHASE-2 AUTHORED TEST — `opice-author` fills in the phase-1 skeleton.
 *
 * Start from the skeleton `opice-plan` wrote (see `skeleton-template.ts`) and
 * turn each *pending* `step(name, { intent, hint })` into an executable
 * `step(name, { intent }, async () => { … })`:
 *   - KEEP `name` and `intent` verbatim — `intent` is the durable spec the body
 *     is checked against; never rewrite it to match what you happened to build.
 *   - KEEP `manual` — the end-user-facing instruction line (target language,
 *     vykání, stupid simple). Only refine its wording to match the **real UI
 *     labels** you saw live (e.g. the exact button text); keep it plain and
 *     non-technical. Don't drop it and don't turn it into a restatement of the
 *     selectors.
 *   - DROP `hint` — it was scaffolding for you; the body now is the "how".
 *   - Fill the body with the concrete selectors/actions you proved while
 *     walking the app in opice-browser.
 * Promote each `invariant.todo(...)` to an enforced `invariant(name, fn)` (or
 * `invariant.fixme(name, reason, fn)` if it genuinely can't hold yet).
 *
 * The DSL is async: `el`/`byRole`/`byLabel` return Playwright Locators; every
 * action and read is awaited, and `step` bodies are async. `expect` is
 * Playwright's web-first expect (re-exported from @opice/harness) — its
 * `toHaveText`/`toBeVisible`/… matchers auto-wait and retry, so they replace
 * manual `waitFor` polling.
 */

// Per-scenario timeout (ms). bun defaults to 5s, but a real browser walk —
// first page load, async data, a dev server compiling on the first request —
// easily exceeds that. `walkthrough` defaults to 60s; override via meta
// `timeout` (or the 2nd arg) when a flow needs more. Each retrying assertion
// still bounds itself.
const TEST_TIMEOUT_MS = 60_000

browserTest(
	{
		name: '<Scenario Title>',
		url: 'http://localhost:15180/<deep-link-route>',
		// hash: '<playground-hash>',
		feature: '<requirement-id>',
		seeds: ['<seed>'],
		roles: ['<role>'],
		timeout: TEST_TIMEOUT_MS,
		// setup: () => mintTokens(...),  // optional: one-time precondition (auth, …)
		// retries: <N>,                  // optional: re-run flaky scenarios (fresh browser per attempt)
	},
	// The async body IS the walkthrough — browserTest owns the test() call, so
	// meta.retries/timeout apply and every retry attempt gets a fresh browser.
	async () => {
		await step('<Step 1 — outcome>', {
			intent: '<kept verbatim from the skeleton>',
			manual: '<kept from the skeleton; labels refined to what you saw live, e.g. „<přesný popisek>">',
		}, async () => {
			await expect(el('<test-id>')).toContainText('<expected text>')
		})

		await step('<Step 2>', {
			intent: '<kept verbatim>',
			manual: '<plain-language line, vykání — „Klikněte na „<Button label>"…">',
		}, async () => {
			await byRole('button', '<Button label>').click()
			await expect(byRole('dialog')).toBeVisible()
		})

		await step('<Step 3>', { intent: '<kept verbatim>' }, async () => {
			await byLabel('<Field label>').fill('<value>')
			await expect(el('<submit-button>')).toBeEnabled()
		})

		await step('<Step 4 — a predicate with no locator assertion>', { intent: '<kept verbatim>' }, async () => {
			await waitFor(async () => (await el('<status>').textContent()) === 'Ready')
		})

		// Promoted from invariant.todo: now enforced. A failing invariant fails
		// the scenario, just like a hard assertion — it IS the acceptance.
		await invariant('<the property that must always hold>', async () => {
			await expect(el('<evidence>')).not.toContainText('<thing that must never appear>')
		})
	},
)
