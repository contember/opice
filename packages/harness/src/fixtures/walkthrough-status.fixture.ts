// Run by scenario-status.test.ts in its own `bun test` process; not a test itself
// (the name keeps bun's discovery away from it). Several scenarios here fail on
// purpose.
import { browserTest, step } from '../index.js'

const url = 'data:text/html,<p>walkthrough</p>'
// Wide enough for a fresh context and navigation on a loaded machine.
const timeout = 3_000
const outlivesTimeout = 8_000

browserTest({ name: 'passes', url, retries: 0 }, async () => {
	await step('a passing step', () => {})
})

browserTest({ name: 'times out', url, timeout, retries: 0 }, async () => {
	await step('a passing step', () => {})
	await Bun.sleep(outlivesTimeout)
})

browserTest({ name: 'throws outside a step', url, retries: 0 }, async () => {
	await step('a passing step', () => {})
	throw new Error('thrown outside any step')
})

// A throw, not a timeout, fails the first attempt: bun kills the browser when a
// test times out, and the retry's setup can race that disconnect.
let retriedAttempts = 0
browserTest({ name: 'throws, then passes on retry', url, retries: 1 }, async () => {
	retriedAttempts++
	await step('a passing step', () => {})
	if (retriedAttempts === 1) throw new Error('thrown outside any step')
})
