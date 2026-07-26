import { describe, expect, test } from 'bun:test'
import { asImpactResult } from './impact'

const INDEX = { edges: 12, scenarios: 3, updatedAt: 1700000000, unindexed: 0 }

describe('asImpactResult', () => {
	test('accepts a well-formed response', () => {
		const result = asImpactResult({
			index: INDEX,
			scenarios: [{
				scenarioKey: 'a.test.ts::checkout',
				scenarioName: 'checkout',
				testFile: 'a.test.ts',
				reasons: [{ kind: 'file', value: 'src/Cart.tsx', matched: 'src/Cart.tsx' }],
				reasonCount: 1,
				updatedAt: 1700000000,
			}],
		})
		expect(result?.index).toEqual(INDEX)
		expect(result?.scenarios).toHaveLength(1)
		expect(result?.scenarios[0]?.reasons[0]?.kind).toBe('file')
	})

	// The whole point of validating: these used to reach impactedTestFiles as a cast.
	test.each([
		['a proxy HTML page', '<html>403</html>'],
		['null', null],
		['an array', []],
		['no index', { scenarios: [] }],
		['no scenarios', { index: INDEX }],
		['scenarios not an array', { index: INDEX, scenarios: {} }],
	])('rejects %s', (_label, payload) => {
		expect(asImpactResult(payload)).toBeNull()
	})

	test('skips malformed scenarios instead of discarding the whole selection', () => {
		const result = asImpactResult({
			index: INDEX,
			scenarios: [
				{ scenarioName: 'no key' },
				null,
				{ scenarioKey: 'k', scenarioName: 'good', testFile: 'b.test.ts', reasons: [], reasonCount: 0, updatedAt: 1 },
			],
		})
		expect(result?.scenarios.map((s) => s.scenarioName)).toEqual(['good'])
	})

	test('drops reasons with an unknown kind, keeping the scenario', () => {
		const result = asImpactResult({
			index: INDEX,
			scenarios: [{
				scenarioKey: 'k',
				scenarioName: 'n',
				testFile: 't.test.ts',
				reasons: [{ kind: 'nonsense', value: 'x', matched: 'x' }, { kind: 'model', value: 'Order', matched: 'Order' }],
				reasonCount: 2,
				updatedAt: 1,
			}],
		})
		expect(result?.scenarios[0]?.reasons.map((r) => r.kind)).toEqual(['model'])
	})

	test('defaults missing numbers rather than emitting NaN', () => {
		const result = asImpactResult({
			index: { edges: 'lots', scenarios: null, updatedAt: 'never' },
			scenarios: [{ scenarioKey: 'k', scenarioName: 'n', testFile: null, reasons: [] }],
		})
		expect(result?.index).toEqual({ edges: 0, scenarios: 0, updatedAt: null, unindexed: 0 })
		// reasonCount falls back to the number of reasons actually present.
		expect(result?.scenarios[0]?.reasonCount).toBe(0)
		expect(result?.scenarios[0]?.testFile).toBeNull()
	})
})
