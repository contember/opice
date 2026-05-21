import { test, describe } from 'bun:test'
import { browserTest, el, byRole, byLabel, waitFor, step, expect } from '@opice/harness'

/**
 * Reference shape for an opice-author-generated test. The real generated
 * file replaces every <PLACEHOLDER> with concrete values discovered while
 * walking the scenario in opice-browser.
 *
 * The DSL is async: `el`/`byRole`/`byLabel` return Playwright Locators; every
 * action and read is awaited, and `step` bodies are async. `expect` is
 * Playwright's web-first expect (re-exported from @opice/harness) — its
 * `toHaveText`/`toBeVisible`/… matchers auto-wait and retry, so they replace
 * manual `waitFor` polling.
 */

// Per-test timeout (3rd arg of test(), ms). bun defaults to 5s, but a real
// browser walk — first page load, async data, a dev server compiling on the
// first request — easily exceeds that. Give the whole walkthrough headroom;
// each retrying assertion still bounds itself.
const TEST_TIMEOUT_MS = 60_000

browserTest('<Scenario Title>', () => {
	test('walkthrough', async () => {
		await step('<Step 1: plain-English description from the .scenario.md>', async () => {
			await expect(el('<test-id>')).toContainText('<expected text>')
		})

		await step('<Step 2>', async () => {
			await byRole('button', '<Button label>').click()
			await expect(byRole('dialog')).toBeVisible()
		})

		await step('<Step 3>', async () => {
			await byLabel('<Field label>').fill('<value>')
			await expect(el('<submit-button>')).toBeEnabled()
		})

		await step('<Step 4: a predicate that has no locator assertion>', async () => {
			await waitFor(async () => (await el('<status>').textContent()) === 'Ready')
		})
	}, TEST_TIMEOUT_MS)
}, '<playground-hash>')
