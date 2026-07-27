import { describe, expect, test } from 'bun:test'
import { indexableKinds, matchImpact, normalizeFootprint, stripQuery, toEdges, type ScenarioFootprint } from './footprint'

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

// The worker is where an arriving payload becomes trusted — the blob it writes
// is served to operators and to anonymous share-link holders. "The collector
// wouldn't send that" is not a property this side may assume.
describe('stripQuery', () => {
	test('leaves a clean route alone', () => {
		expect(stripQuery('/api/orders/:id')).toEqual({ route: '/api/orders/:id', params: [] })
	})

	test('drops values, keeps names', () => {
		expect(stripQuery('/reset?token=sk-live-SECRET&email=a@b.test'))
			.toEqual({ route: '/reset', params: ['email', 'token'] })
	})

	test('drops the fragment', () => {
		expect(stripQuery('/app#/invoices/8f3c')).toEqual({ route: '/app', params: [] })
	})
})

describe('normalizeFootprint sanitizes routes', () => {
	const withRoute = (route: string) => normalizeFootprint({
		scenario: 's',
		requests: [{ step: 0, method: 'GET', route, status: 200, resourceType: 'fetch', durationMs: 1 }],
		endpoints: [{ route, methods: ['GET'], count: 1 }],
	})

	test('a legacy reporter cannot publish query values', () => {
		const result = withRoute('/reset?token=sk-live-SECRET')
		expect(result.requests[0]?.route).toBe('/reset')
		expect(result.endpoints[0]?.route).toBe('/reset')
		expect(JSON.stringify(result)).not.toContain('sk-live-SECRET')
	})

	test('recovered parameter names are folded into params', () => {
		expect(withRoute('/search?q=hunter2').requests[0]?.params).toEqual(['q'])
	})
})

describe('matchImpact name matching', () => {
	const edge = (kind: 'model' | 'file', value: string) => ({
		scenarioKey: 'tests/a.test.ts::a',
		testFile: 'tests/a.test.ts',
		scenarioName: 'a',
		kind,
		value,
		exercised: true,
		writes: false,
		updatedAt: 1,
	})

	test('a model edge matches its schema file across naming styles', () => {
		// The two ends spell the same thing differently: Contember defines
		// `EducationProgramSession` in `education-program-session.ts`. Measured on a
		// real repo, 203 of 304 entities live in a multi-word file, so exact-basename
		// matching reached only the single-word minority.
		const path = 'packages/api/model/edu/education-program-session.ts'
		expect(matchImpact([edge('model', 'EducationProgramSession')], { paths: [path] })).toHaveLength(1)
	})

	test('still matches the single-word case it always did', () => {
		expect(matchImpact([edge('model', 'Contract')], { paths: ['packages/api/model/contract.ts'] })).toHaveLength(1)
	})

	test('does not match an unrelated entity', () => {
		expect(matchImpact([edge('model', 'Invoice')], { paths: ['packages/api/model/contract.ts'] })).toEqual([])
	})

	test('a file edge naming the schema file matches exactly, without the heuristic', () => {
		const path = 'packages/api/model/edu/education-program-session.ts'
		const matched = matchImpact([edge('file', path)], { paths: [path] })
		expect(matched[0]?.reasons[0]).toMatchObject({ kind: 'file', value: path })
	})
})
