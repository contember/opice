import { test, expect, describe } from 'bun:test'
import { browserTest, el, tid, waitFor, step } from '@opice/harness'

/**
 * Reference shape for an opice-author-generated test. The real generated
 * file replaces every <PLACEHOLDER> with concrete values discovered while
 * walking the scenario in agent-browser.
 */

// Per-test timeout (3rd arg of test(), ms). bun defaults to 5s, but `waitFor`
// blocks synchronously (Bun.sleepSync) and a real browser walk — first page
// load, async data, a dev server compiling on the first request — easily
// exceeds that, surfacing as a misleading "timed out after 5000ms". Give the
// whole walkthrough headroom; each wait still bounds itself via its own
// `waitFor` timeout.
const TEST_TIMEOUT_MS = 60_000

browserTest('<Scenario Title>', () => {
	test('walkthrough', () => {
		step('<Step 1: plain-English description from the .scenario.md>', () => {
			waitFor(() => el(tid('<test-id>')).exists)
			expect(el(tid('<test-id>')).text).toContain('<expected text>')
		})

		step('<Step 2>', () => {
			el(tid('<button-id>')).click()
			waitFor(() => el(tid('<dialog-marker>')).exists)
		})

		step('<Step 3>', () => {
			el(tid('<input-id>')).fill('<value>')
			expect(el(tid('<submit-button>')).isDisabled).toBe(false)
		})
	}, TEST_TIMEOUT_MS)
}, '<playground-hash>')
