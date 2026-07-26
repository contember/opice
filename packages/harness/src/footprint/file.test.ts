import { describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { footprintStem, writeFootprintFile } from './file'
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

describe('writeFootprintFile', () => {
	// The collector's first invariant: it observes, it never fails a test. A
	// user's `mapOperation` can put anything into `models` — a cyclic object, a
	// BigInt — and serializing that used to throw straight through afterAll.
	test('a footprint that cannot be serialized returns null instead of throwing', async () => {
		const cyclic = fp('cyclic', 'a.test.ts') as ScenarioFootprint & { self?: unknown }
		cyclic.self = cyclic
		const dir = path.join(tmpdir(), `opice-footprint-test-${process.pid}`)
		expect(await writeFootprintFile(cyclic, dir)).toBeNull()
	})

	test('a serializable footprint returns its JSON', async () => {
		const dir = path.join(tmpdir(), `opice-footprint-test-${process.pid}`)
		const json = await writeFootprintFile(fp('ok', 'a.test.ts'), dir)
		expect(json).toContain('"scenario": "ok"')
		await rm(dir, { recursive: true, force: true })
	})
})
