import { describe, expect, test } from 'bun:test'
import { footprintStem } from './file'
import type { ScenarioFootprint } from './types'

function fp(scenario: string, testFile?: string): ScenarioFootprint {
	return {
		scenario,
		...(testFile ? { testFile } : {}),
		collected: [],
		files: [],
		components: [],
		requests: [],
		endpoints: [],
		models: [],
	}
}

describe('footprintStem', () => {
	test('leads with the test file, then the scenario', () => {
		expect(footprintStem(fp('checkout works', 'apps/web/cart.test.ts')))
			.toMatch(/^apps-web-cart-[a-z0-9]+--checkout-works$/)
	})

	// Slugifying collapses `/` and `-` alike, so these two share a slug. They run
	// in separate processes, so nothing at runtime can notice them racing.
	test('separates paths that slugify identically', () => {
		const a = footprintStem(fp('same name', 'a/b.test.ts'))
		const b = footprintStem(fp('same name', 'a-b.test.ts'))
		expect(a).not.toBe(b)
	})

	test('is stable for the same input', () => {
		expect(footprintStem(fp('x', 'a/b.test.ts'))).toBe(footprintStem(fp('x', 'a/b.test.ts')))
	})

	test('still distinguishes scenarios within one file', () => {
		expect(footprintStem(fp('one', 'a.test.ts'))).not.toBe(footprintStem(fp('two', 'a.test.ts')))
	})

	test('falls back to the scenario alone with no test file', () => {
		expect(footprintStem(fp('checkout works'))).toBe('checkout-works')
	})
})
