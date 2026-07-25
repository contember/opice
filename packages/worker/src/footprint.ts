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

import type { FootprintEdgeKind, FootprintSummary } from './types'

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

/** How many model names a summary carries — enough for a badge row, not a list. */
const SUMMARY_MODEL_LIMIT = 8

/**
 * Reduce a footprint to the counts stored on the scenario row, so a list view
 * needn't fetch the blob out of R2 to badge a scenario. Written models come
 * first: "this scenario writes Invoice" is the fact worth seeing at a glance.
 */
export function summarize(footprint: ScenarioFootprint): FootprintSummary {
	const models = [...footprint.models].sort((a, b) => (Number(b.write) - Number(a.write)) || a.name.localeCompare(b.name))
	return {
		files: footprint.files.length,
		components: footprint.components.length,
		endpoints: footprint.endpoints.length,
		models: footprint.models.length,
		requests: footprint.requests.length,
		topModels: models.slice(0, SUMMARY_MODEL_LIMIT).map((m) => m.name),
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

/** Flatten a footprint into the change-tracking index's edge rows. */
export function toEdges(footprint: ScenarioFootprint): { kind: FootprintEdgeKind; value: string; weight?: number; writes?: boolean }[] {
	const edges: { kind: FootprintEdgeKind; value: string; weight?: number; writes?: boolean }[] = []
	for (const file of footprint.files) {
		edges.push({
			kind: 'file',
			value: file.path,
			...(typeof file.executed === 'number' ? { weight: Math.round(file.executed * 1000) } : {}),
		})
	}
	for (const component of footprint.components) edges.push({ kind: 'component', value: component })
	for (const endpoint of footprint.endpoints) edges.push({ kind: 'endpoint', value: endpoint.route })
	for (const model of footprint.models) edges.push({ kind: 'model', value: model.name, writes: model.write })
	return edges
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
