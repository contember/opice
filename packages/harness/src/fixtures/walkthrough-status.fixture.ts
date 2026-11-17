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

let retriedAttempts = 0
browserTest({ name: 'throws, then passes on retry', url, retries: 1 }, async () => {
	retriedAttempts++
	await step('a passing step', () => {})
	if (retriedAttempts === 1) throw new Error('thrown outside any step')
})

// bun terminates the shared browser when a test times out; the retry must launch a new one.
let timedOutAttempts = 0
browserTest({ name: 'times out, then passes on retry', url, timeout, retries: 1 }, async () => {
	timedOutAttempts++
	await step('a passing step', () => {})
	if (timedOutAttempts === 1) await Bun.sleep(outlivesTimeout)
})

// The first body returns while the second scenario runs; it must not mark the
// second one complete, which then throws outside a step.
browserTest({ name: 'times out, returns during the next', url, timeout, retries: 0 }, async () => {
	await step('a passing step', () => {})
	await Bun.sleep(timeout + 1_500)
})

browserTest({ name: 'throws after the previous body returned', url, retries: 0 }, async () => {
	await step('a passing step', () => {})
	await Bun.sleep(3_000)
	throw new Error('thrown outside any step')
})
