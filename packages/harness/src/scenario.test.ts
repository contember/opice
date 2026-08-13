import { describe, expect, test } from 'bun:test'
import { settleWithin } from './scenario'

/**
 * The bound on a skip report. A `skipped (tier)` test does no browser work, so
 * every millisecond it spends is the platform POST — and the reporter's own
 * budget outlasts the test's, which is what used to fail skipped scenarios in a
 * contended CI.
 */
describe('settleWithin', () => {
	test('returns as soon as the promise resolves', async () => {
		const started = performance.now()
		await settleWithin(Promise.resolve('reported'), 5_000)
		expect(performance.now() - started).toBeLessThan(1_000)
	})

	test('gives up on a hanging promise instead of blocking', async () => {
		const started = performance.now()
		// The bug: a report that never settles used to hold the test until bun
		// killed it at 5s, turning a skipped scenario into a failed one.
		await settleWithin(new Promise(() => {}), 50)
		const elapsed = performance.now() - started
		expect(elapsed).toBeGreaterThanOrEqual(45)
		expect(elapsed).toBeLessThan(1_000)
	})

	test('swallows a rejection rather than failing its caller', async () => {
		expect(settleWithin(Promise.reject(new Error('platform down')), 5_000)).resolves.toBeUndefined()
	})

	test('swallows a rejection that lands after the budget', async () => {
		// An abandoned straggler still needs its handler, or the process takes an
		// unhandled rejection once the test that started it is long gone.
		const late = new Promise((_, reject) => setTimeout(() => reject(new Error('too late')), 30))
		await settleWithin(late, 5)
		await Bun.sleep(60)
	})
})
