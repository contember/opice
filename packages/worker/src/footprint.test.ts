import { describe, expect, test } from 'bun:test'
import { indexableKinds, toEdges, type ScenarioFootprint } from './footprint'

function footprint(overrides: Partial<ScenarioFootprint> = {}): ScenarioFootprint {
	return {
		scenario: 'checkout',
		testFile: 'apps/web/checkout.test.ts',
		collected: [],
		files: [],
		components: [],
		requests: [],
		endpoints: [],
		models: [],
		...overrides,
	}
}

describe('indexableKinds', () => {
	test('a full run speaks for every dimension', () => {
		const kinds = indexableKinds(footprint({ collected: ['network', 'graphql', 'modules', 'coverage', 'components'] }))
		expect(kinds.sort()).toEqual(['component', 'endpoint', 'file', 'model'])
	})

	// The case this exists for: network mode against a production bundle sees
	// every endpoint and zero files, and must not be allowed to say so.
	test('a network-only run does not speak for files', () => {
		const kinds = indexableKinds(footprint({ collected: ['network', 'graphql'] }))
		expect(kinds).toContain('endpoint')
		expect(kinds).toContain('model')
		expect(kinds).not.toContain('file')
	})

	test('either file collector alone is enough for files', () => {
		expect(indexableKinds(footprint({ collected: ['modules'] }))).toEqual(['file'])
		expect(indexableKinds(footprint({ collected: ['coverage'] }))).toEqual(['file'])
	})

	// A partial list is a sample, and replacing a complete set with a sample drops
	// whatever fell off the end.
	test('a partial dimension is not authoritative', () => {
		expect(indexableKinds(footprint({ collected: ['modules'], partial: ['files'] }))).toEqual([])
		const capped = indexableKinds(footprint({ collected: ['network', 'graphql'], partial: ['endpoints', 'models'] }))
		expect(capped).toEqual([])
	})

	test('a partial dimension leaves the others authoritative', () => {
		const kinds = indexableKinds(footprint({ collected: ['modules', 'network'], partial: ['endpoints'] }))
		expect(kinds).toEqual(['file'])
	})

	// A collector can run to completion and learn nothing: against a bundle the
	// module collector recognises no source paths at all. "No files" from there
	// means "could not tell", and must not delete a dev-server run's file edges.
	test('a run against a bundle does not speak for files', () => {
		const kinds = indexableKinds(footprint({ collected: ['modules', 'network', 'graphql'], partial: ['files'] }))
		expect(kinds).not.toContain('file')
		expect(kinds).toContain('endpoint')
	})

	// A persisted query hides the document, so the models are unknown — but the
	// endpoint it was posted to was perfectly visible.
	test('persisted queries cost the models, not the endpoints', () => {
		const kinds = indexableKinds(footprint({ collected: ['network', 'graphql'], partial: ['models'] }))
		expect(kinds).toEqual(['endpoint'])
	})

	test('a run that collected nothing indexes nothing', () => {
		expect(indexableKinds(footprint())).toEqual([])
	})
})

describe('toEdges', () => {
	const full = footprint({
		collected: ['network', 'graphql', 'modules'],
		files: [{ path: 'src/Cart.tsx', exercised: true, source: 'coverage' }],
		components: ['Cart'],
		endpoints: [{ route: '/api/orders', methods: ['GET'], count: 1 }],
		models: [{ name: 'Order', write: true }],
	})

	test('emits every kind when unrestricted', () => {
		expect([...new Set(toEdges(full).map((e) => e.kind))].sort())
			.toEqual(['component', 'endpoint', 'file', 'model'])
	})

	test('emits only the permitted kinds', () => {
		const edges = toEdges(full, ['endpoint', 'model'])
		expect(edges.some((e) => e.value === 'src/Cart.tsx')).toBe(false)
		expect(edges.some((e) => e.value === 'Cart')).toBe(false)
		expect(edges.some((e) => e.value === '/api/orders')).toBe(true)
	})

	// Without this, a network-only run would stop a test from selecting itself
	// when its own source changed.
	test('always emits the scenario’s own test file, even when files are excluded', () => {
		const edges = toEdges(full, ['endpoint'])
		expect(edges).toContainEqual({ kind: 'file', value: 'apps/web/checkout.test.ts', exercised: true })
	})

	test('marks a file exercised unless explicitly false', () => {
		const edges = toEdges(footprint({ files: [{ path: 'a.ts', exercised: false, source: 'module' }, { path: 'b.ts', source: 'module' }] }))
		expect(edges.find((e) => e.value === 'a.ts')?.exercised).toBe(false)
		expect(edges.find((e) => e.value === 'b.ts')?.exercised).toBe(true)
	})
})
