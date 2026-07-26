/**
 * Footprint ingest helpers — validation, summarizing, and flattening to index rows.
 *
 * The shapes here MIRROR `@opice/harness`'s footprint types rather than
 * importing them. The worker deliberately doesn't depend on the test runtime:
 * the harness is a package the *user's* repo installs, versioned and released on
 * its own cadence, and a worker that imported it would be pinned to whatever
 * version its bundle happened to carry — while still having to accept payloads
 * from every other version in the wild. Since the payload is validated on
 * arrival regardless, the type is duplicated and the validation is the contract.
 */

import type { FootprintEdge, FootprintEdgeKind, FootprintSummary, ImpactedScenario, ImpactReason } from './types'

export interface FootprintFile {
	path: string
	source: 'module' | 'coverage'
	executed?: number
}

export interface FootprintModel {
	name: string
	write: boolean
}

export interface FootprintEndpoint {
	route: string
	methods: string[]
	count: number
}

export type FootprintCollectorKind = 'network' | 'graphql' | 'modules' | 'coverage' | 'components'

export interface ScenarioFootprint {
	scenario: string
	testFile?: string
	collected: FootprintCollectorKind[]
	files: FootprintFile[]
	components: string[]
	/** Per-request detail. Kept verbatim for the blob; the index doesn't read it. */
	requests: unknown[]
	endpoints: FootprintEndpoint[]
	models: FootprintModel[]
	warnings?: string[]
}

/**
 * Reduce a footprint to the counts stored on the scenario row, so a list view
 * can badge a scenario without fetching the blob out of R2. Counts only — the
 * moment a view needs the names, it needs the blob anyway.
 */
export function summarize(footprint: ScenarioFootprint): FootprintSummary {
	return {
		files: footprint.files.length,
		components: footprint.components.length,
		endpoints: footprint.endpoints.length,
		models: footprint.models.length,
		requests: footprint.requests.length,
		warnings: footprint.warnings?.length ?? 0,
	}
}

/**
 * Validate the parts of a footprint we actually use, dropping the rest.
 *
 * The reporter is authenticated, but "authenticated" is not "well-formed": an
 * older harness, a truncated upload or a hand-rolled client can all arrive here,
 * and what survives is written into an index that decides which tests run. Bad
 * entries are dropped rather than rejecting the whole payload — a footprint that
 * indexes most of what it touched is worth far more than a 400.
 *
 * Throws only when the payload isn't a footprint at all.
 */
export function normalizeFootprint(input: unknown): ScenarioFootprint {
	if (typeof input !== 'object' || input === null) throw new Error('expected an object')
	const raw = input as Record<string, unknown>
	const scenario = raw['scenario']
	if (typeof scenario !== 'string' || !scenario) throw new Error('scenario is required')
	const testFile = raw['testFile']
	return {
		scenario,
		...(typeof testFile === 'string' && testFile ? { testFile } : {}),
		collected: asArray(raw['collected']).filter(isCollectorKind),
		files: asArray(raw['files']).flatMap(toFile),
		components: asArray(raw['components']).filter(isNonEmptyString),
		requests: asArray(raw['requests']),
		endpoints: asArray(raw['endpoints']).flatMap(toEndpoint),
		models: asArray(raw['models']).flatMap(toModel),
		...(Array.isArray(raw['warnings']) ? { warnings: raw['warnings'].filter(isNonEmptyString) } : {}),
	}
}

/**
 * Extensions V8 coverage can attribute. A stylesheet is executed by the browser's
 * CSS engine, never by V8, so it can only ever be observed by the module
 * collector — marking it "loaded, not called" would be a statement about our
 * instrumentation rather than about the scenario, and would quietly drop every
 * stylesheet out of impact selection.
 */
const V8_MEASURABLE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i

/** Flatten a footprint into the change-tracking index's edge rows. */
export function toEdges(footprint: ScenarioFootprint): FootprintEdgeInput[] {
	const edges: FootprintEdgeInput[] = []
	// Without the coverage collector there is no way to tell a file the scenario
	// CALLED from one it merely loaded — so every file edge carries the strongest
	// claim the data supports rather than being silently downgraded to "loaded",
	// which would make impact selection match nothing at all in `network` mode.
	const canTellExercised = footprint.collected.includes('coverage')
	for (const file of footprint.files) {
		const measurable = V8_MEASURABLE.test(file.path)
		edges.push({
			kind: 'file',
			value: file.path,
			exercised: !canTellExercised || !measurable || file.source === 'coverage',
		})
	}
	for (const component of footprint.components) edges.push({ kind: 'component', value: component })
	for (const endpoint of footprint.endpoints) edges.push({ kind: 'endpoint', value: endpoint.route })
	for (const model of footprint.models) edges.push({ kind: 'model', value: model.name, writes: model.write })
	return edges
}

/** One row destined for `footprint_edges`. */
export interface FootprintEdgeInput {
	kind: FootprintEdgeKind
	value: string
	writes?: boolean
	/** File edges: was code in the file actually called, or was it only loaded? */
	exercised?: boolean
}

/** `\` → `/`, drop a leading `./`, trim a trailing slash. Mirrors the harness's select-path shape. */
export function normalizePath(p: string): string {
	let s = p.trim().replace(/\\/g, '/')
	while (s.startsWith('./')) s = s.slice(2)
	if (s.length > 1) s = s.replace(/\/+$/, '')
	return s
}

/** `apps/web/src/InvoiceForm.tsx` → `InvoiceForm`. Empty for a dotfile or a bare directory. */
export function basenameWithoutExtension(p: string): string {
	const base = p.slice(p.lastIndexOf('/') + 1)
	const dot = base.lastIndexOf('.')
	return dot > 0 ? base.slice(0, dot) : base
}

/** The last path segment (`src/App.tsx` → `App.tsx`), the key both suffix directions must share. */
function lastSegment(p: string): string {
	return p.slice(p.lastIndexOf('/') + 1)
}

export interface ImpactQuery {
	/** Repo-relative paths from a diff. */
	paths: string[]
	/** Explicit model names, for a change the paths can't express (a schema edit). */
	models?: string[]
	/**
	 * Also match files the scenario only *loaded*. Off by default because that
	 * dimension saturates — see `exercised` in migration 0012.
	 */
	includeLoaded?: boolean
}

/**
 * Match a project's index against a change — the read half of the domain
 * {@link toEdges} owns the write half of, which is why it lives here rather than
 * beside the SQL: this is the one function that decides which tests a PR runs,
 * and keeping it out of `db.ts` makes it testable without D1.
 *
 * Matching is deliberately generous in two directions, because both are cheap
 * and a missed scenario is the expensive kind of wrong:
 *
 *  - **Path shape.** A footprint records the path as the browser saw it
 *    (`src/App.tsx`), a diff gives the path as the repo sees it
 *    (`apps/web/src/App.tsx`). Either may be a suffix of the other, so both
 *    directions match — the same tolerance `select.ts` applies to test files.
 *  - **Name.** A changed `InvoiceForm.tsx` also matches a *component* edge named
 *    `InvoiceForm` and an explicitly named *model* edge, which is how a component
 *    whose file moved is still found.
 *
 * Both suffix directions require the final path segment to be equal, so the
 * changed paths are bucketed by that segment once and each edge does a single
 * lookup — over an index of ~10k edges against a few hundred changed paths, the
 * naive nested scan would be millions of comparisons.
 *
 * Returns one entry per scenario with the reasons it matched, so the caller can
 * explain the selection rather than presenting it as an oracle.
 */
export function matchImpact(edges: readonly FootprintEdge[], query: ImpactQuery): ImpactedScenario[] {
	const paths = [...new Set(query.paths.map(normalizePath).filter(Boolean))]
	const models = [...new Set((query.models ?? []).filter(Boolean))]
	if (paths.length === 0 && models.length === 0) return []

	const byLastSegment = new Map<string, string[]>()
	const byBasename = new Map<string, string>()
	for (const path of paths) {
		const segment = lastSegment(path)
		const bucket = byLastSegment.get(segment)
		if (bucket) bucket.push(path)
		else byLastSegment.set(segment, [path])
		const base = basenameWithoutExtension(path)
		if (base) byBasename.set(base.toLowerCase(), path)
	}
	const namedModels = new Map<string, string>(models.map((m) => [m.toLowerCase(), m]))

	const byScenario = new Map<string, ImpactedScenario>()
	for (const edge of edges) {
		const matched = matchEdge(edge, byLastSegment, byBasename, namedModels, query.includeLoaded === true)
		if (!matched) continue
		const existing = byScenario.get(edge.scenarioKey)
		const reason: ImpactReason = { kind: edge.kind, value: edge.value, matched }
		if (existing) {
			// Cap the reasons carried per scenario: the caller shows the first few
			// and a count, and a broad diff can otherwise match hundreds of edges on
			// one scenario, all of which would ride back in the JSON response.
			if (existing.reasons.length < MAX_REASONS_PER_SCENARIO) existing.reasons.push(reason)
			existing.reasonCount++
			existing.updatedAt = Math.max(existing.updatedAt, edge.updatedAt)
		} else {
			byScenario.set(edge.scenarioKey, {
				scenarioKey: edge.scenarioKey,
				testFile: edge.testFile,
				scenarioName: edge.scenarioName,
				reasons: [reason],
				reasonCount: 1,
				updatedAt: edge.updatedAt,
			})
		}
	}
	return [...byScenario.values()].sort((a, b) => a.scenarioName.localeCompare(b.scenarioName))
}

/** How many match reasons travel back per scenario; the rest are counted, not listed. */
const MAX_REASONS_PER_SCENARIO = 5

/** Does a changed path reach this edge? Returns the path that matched, or null. */
function matchEdge(
	edge: FootprintEdge,
	byLastSegment: ReadonlyMap<string, readonly string[]>,
	byBasename: ReadonlyMap<string, string>,
	namedModels: ReadonlyMap<string, string>,
	includeLoaded: boolean,
): string | null {
	if (edge.kind === 'file') {
		// A merely-loaded file is a true but nearly useless signal (see `exercised`
		// in migration 0012) — skipped unless the caller asks to widen.
		if (!includeLoaded && !edge.exercised) return null
		const value = normalizePath(edge.value)
		for (const path of byLastSegment.get(lastSegment(value)) ?? []) {
			if (value === path || value.endsWith('/' + path) || path.endsWith('/' + value)) return path
		}
		return null
	}
	if (edge.kind === 'component' || edge.kind === 'model') {
		const explicit = namedModels.get(edge.value.toLowerCase())
		if (edge.kind === 'model' && explicit !== undefined) return explicit
		return byBasename.get(edge.value.toLowerCase()) ?? null
	}
	return null
}

/** A scenario's identity ACROSS runs — the key the impact index is built on. */
export function scenarioKeyOf(testFile: string | null, name: string): string {
	return testFile ? `${testFile}::${name}` : name
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0
}

function isCollectorKind(value: unknown): value is FootprintCollectorKind {
	return value === 'network' || value === 'graphql' || value === 'modules' || value === 'coverage' || value === 'components'
}

function toFile(value: unknown): FootprintFile[] {
	if (typeof value !== 'object' || value === null) return []
	const record = value as Record<string, unknown>
	const path = record['path']
	if (!isNonEmptyString(path)) return []
	const executed = record['executed']
	return [{
		path,
		source: record['source'] === 'coverage' ? 'coverage' : 'module',
		...(typeof executed === 'number' && Number.isFinite(executed) ? { executed } : {}),
	}]
}

function toModel(value: unknown): FootprintModel[] {
	if (typeof value !== 'object' || value === null) return []
	const record = value as Record<string, unknown>
	const name = record['name']
	if (!isNonEmptyString(name)) return []
	return [{ name, write: record['write'] === true }]
}

function toEndpoint(value: unknown): FootprintEndpoint[] {
	if (typeof value !== 'object' || value === null) return []
	const record = value as Record<string, unknown>
	const route = record['route']
	if (!isNonEmptyString(route)) return []
	const count = record['count']
	return [{
		route,
		methods: asArray(record['methods']).filter(isNonEmptyString),
		count: typeof count === 'number' && Number.isFinite(count) ? count : 0,
	}]
}
