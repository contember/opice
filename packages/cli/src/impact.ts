/**
 * Change tracking — turning a diff into a scenario selection.
 *
 * The platform knows what each scenario touched the last time it ran (its
 * footprint); git knows what a branch changed. Intersecting the two gives the
 * scenarios a change can actually reach, which is what `opice test --impacted`
 * runs on top of its tier.
 *
 * The governing rule is **fail open**. Every failure mode here — no credentials,
 * an unreachable platform, an index that was never built, a file nothing has
 * ever loaded — resolves to "no extra scenarios selected", never to an error and
 * never to a smaller run than the tier asked for. A selection mechanism that can
 * *subtract* coverage when it breaks is worse than no selection at all, so this
 * one can only ever add.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseOpiceDsn } from './dsn'
import { changedPaths, defaultBase, gitLines, gitPaths } from './git'

/** How the platform describes its own index, so an empty answer can be explained. */
export interface ImpactIndexStatus {
	edges: number
	scenarios: number
	updatedAt: number | null
	/** Scenarios the project has reported that carry no edges — see {@link resolveImpact}. */
	unindexed: number
}

export interface ImpactReason {
	kind: 'file' | 'component' | 'endpoint' | 'model'
	value: string
	matched: string
}

export interface ImpactedScenario {
	scenarioKey: string
	testFile: string | null
	scenarioName: string
	/** The first few reasons it matched; `reasonCount` is how many there were. */
	reasons: ImpactReason[]
	reasonCount: number
	updatedAt: number
}

export interface ImpactResult {
	scenarios: ImpactedScenario[]
	index: ImpactIndexStatus
}

export interface ImpactCredentials {
	endpoint: string
	project: string
	clientId: string
	clientSecret: string
}

/**
 * Resolve the credentials for an impact query. The read DSN is preferred (it's
 * the least-privileged thing that works); the ingest DSN is accepted because
 * that's what a CI job running `--impacted` already has.
 */
export function resolveImpactCredentials(config: { project?: string; endpoint?: string }): ImpactCredentials | null {
	const read = parseOpiceDsn(process.env['OPICE_READ_DSN'])
	const write = parseOpiceDsn(process.env['OPICE_DSN'])
	const dsn = read ?? write
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config.endpoint ?? dsn?.endpoint
	const project = process.env['OPICE_PROJECT'] ?? config.project ?? dsn?.project
	const clientId = dsn?.clientId ?? process.env['OPICE_CLIENT_ID']
	const clientSecret = dsn?.clientSecret ?? process.env['OPICE_CLIENT_SECRET']
	if (!endpoint || !project || !clientId || !clientSecret) return null
	return { endpoint, project, clientId, clientSecret }
}

/** Ask the platform which scenarios a change reaches. Returns null when it can't be asked. */
export async function queryImpact(
	credentials: ImpactCredentials,
	input: { paths: string[]; models?: string[]; includeLoaded?: boolean },
): Promise<ImpactResult | null> {
	const url = `${credentials.endpoint}/api/v1/${credentials.project}/impact`
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'cf-access-client-id': credentials.clientId,
				'cf-access-client-secret': credentials.clientSecret,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				paths: input.paths,
				models: input.models ?? [],
				...(input.includeLoaded ? { includeLoaded: true } : {}),
			}),
			redirect: 'manual',
			signal: AbortSignal.timeout(15_000),
		})
		if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
			console.error('[opice] impact query was redirected to Cloudflare Access — the service token was rejected at the edge.')
			return null
		}
		if (!response.ok) {
			console.error(`[opice] impact query failed: ${response.status} ${(await response.text()).trim()}`)
			return null
		}
		const parsed = asImpactResult(await response.json())
		if (!parsed) {
			console.error('[opice] impact query returned a response this CLI does not understand — ignoring it.')
			return null
		}
		return parsed
	} catch (err) {
		console.error(`[opice] impact query failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

/**
 * Validate a platform response into an {@link ImpactResult}, or null if it isn't one.
 *
 * The payload decides which tests a PR runs, so it is checked rather than cast.
 * A cast would let a proxy's HTML error page, an older platform's shape, or a
 * truncated body reach {@link impactedTestFiles} as `undefined.map` — a crash in
 * the one code path whose whole contract is to fail open. Unknown fields are
 * dropped and malformed scenarios are skipped individually: a single bad row
 * shouldn't discard an otherwise usable selection.
 */
export function asImpactResult(payload: unknown): ImpactResult | null {
	if (!isRecord(payload) || !Array.isArray(payload['scenarios'])) return null
	const rawIndex = payload['index']
	if (!isRecord(rawIndex)) return null
	const index: ImpactIndexStatus = {
		edges: num(rawIndex['edges']),
		scenarios: num(rawIndex['scenarios']),
		updatedAt: typeof rawIndex['updatedAt'] === 'number' ? rawIndex['updatedAt'] : null,
		unindexed: num(rawIndex['unindexed']),
	}
	const scenarios = payload['scenarios'].flatMap((raw) => {
		if (!isRecord(raw)) return []
		const scenarioKey = raw['scenarioKey']
		const scenarioName = raw['scenarioName']
		if (typeof scenarioKey !== 'string' || typeof scenarioName !== 'string') return []
		const testFile = raw['testFile']
		const reasons = Array.isArray(raw['reasons']) ? raw['reasons'].flatMap(asReason) : []
		return [{
			scenarioKey,
			scenarioName,
			testFile: typeof testFile === 'string' ? testFile : null,
			reasons,
			reasonCount: typeof raw['reasonCount'] === 'number' ? raw['reasonCount'] : reasons.length,
			updatedAt: num(raw['updatedAt']),
		}]
	})
	return { scenarios, index }
}

const REASON_KINDS = new Set(['file', 'component', 'endpoint', 'model'])

function asReason(raw: unknown): ImpactReason[] {
	if (!isRecord(raw)) return []
	const { kind, value, matched } = raw
	if (typeof kind !== 'string' || !REASON_KINDS.has(kind)) return []
	if (typeof value !== 'string' || typeof matched !== 'string') return []
	return [{ kind: kind as ImpactReason['kind'], value, matched }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Test files of the impacted scenarios, deduplicated — what feeds `--select`.
 *
 * Files that no longer exist are dropped. The index is keyed on a scenario's
 * test file + name, so a renamed or deleted test leaves an entry behind until it
 * ages out; passing that stale path to `--select` would be a selection nobody
 * can act on. The working tree is the authority on what exists, and only the
 * caller has it.
 */
export function impactedTestFiles(scenarios: readonly ImpactedScenario[]): string[] {
	const files = [...new Set(scenarios.map((s) => s.testFile).filter((f): f is string => !!f))].sort()
	return files.filter(existsInRepo)
}

/**
 * Does this indexed path name a file in the checkout?
 *
 * Three ways, because the path's own root is not knowable from the path. A
 * footprint records it relative to the repository — but a run from a package
 * subdirectory with an older harness recorded it relative to THAT, and neither
 * form announces which it is. Resolving against a single root drops the other
 * and silently empties the selection, so the tracked-file list decides: it is
 * the authority on what exists, and a suffix match finds the file whichever root
 * the path was written against.
 */
function existsInRepo(file: string): boolean {
	const root = repoRoot()
	if (existsSync(path.resolve(root ?? process.cwd(), file))) return true
	if (existsSync(path.resolve(process.cwd(), file))) return true
	return trackedFiles().some((tracked) => tracked === file || tracked.endsWith('/' + file))
}

/** The repository root, or null outside a checkout. Resolved once. */
let cachedRoot: string | null | undefined
function repoRoot(): string | null {
	if (cachedRoot === undefined) cachedRoot = gitLines('rev-parse', '--show-toplevel')[0] ?? null
	return cachedRoot
}

/** Every tracked file, repo-relative. Resolved once — one `git ls-files` per invocation. */
let cachedTracked: string[] | undefined
function trackedFiles(): string[] {
	// `-z` again: a C-quoted name here would fail to match the very path it is.
	if (cachedTracked === undefined) cachedTracked = gitPaths('ls-files', '-z')
	return cachedTracked
}

/**
 * One line explaining a scenario's selection. A selection nobody can explain is
 * a selection nobody trusts, and the first time `--impacted` runs a surprising
 * set of tests this is what settles the argument.
 */
export function explainSelection(scenario: ImpactedScenario): string {
	const shown = scenario.reasons.slice(0, 3)
	const reasons = shown.map((r) => `${r.kind} ${r.value}`)
	const extra = scenario.reasonCount > shown.length ? ` (+${scenario.reasonCount - shown.length} more)` : ''
	return `${scenario.scenarioName} — ${reasons.join(', ')}${extra}`
}

export interface ResolvedImpact {
	base: string
	paths: string[]
	/** Test files of the impacted scenarios — what feeds `--select`. */
	files: string[]
	result: ImpactResult
}

/**
 * Run the whole impact question — credentials, diff, query — and narrate it on
 * stderr, so `opice impact` and `opice test --impacted` explain the same query
 * the same way instead of each wording it themselves.
 *
 * Returns null when it cannot answer. Every such branch is a *warning*, never an
 * error: `--impacted` only ever ADDS scenarios to the tier, so a run that can't
 * be narrowed is simply the tier — correct, if less targeted. Turning that into
 * a failure would let a dashboard outage block every PR.
 */
export async function resolveImpact(
	config: { project?: string; endpoint?: string },
	options: { base?: string; models?: string[]; includeLoaded?: boolean; label?: string } = {},
): Promise<ResolvedImpact | null> {
	const label = options.label ?? 'impact'
	const credentials = resolveImpactCredentials(config)
	if (!credentials) {
		warn(`${label} needs a platform credential — set OPICE_READ_DSN (preferred) or OPICE_DSN.`)
		return null
	}
	const base = options.base ?? defaultBase()
	const paths = changedPaths(base)
	const models = options.models ?? []
	if (paths.length === 0 && models.length === 0) {
		console.error(`[opice] ${label}: no changes against ${base}.`)
		return null
	}
	const queryOptions = { paths, models, ...(options.includeLoaded ? { includeLoaded: true } : {}) }
	const result = await queryImpact(credentials, queryOptions)
	if (!result) {
		warn(`${label} could not reach the platform.`)
		return null
	}
	if (result.index.scenarios === 0) {
		warn(
			`${label}: the footprint index is EMPTY, so this answer means "unknown", not "nothing". Build it with `
			+ '`opice test --footprint` on a CI run of the default branch — only main/master writes the index, so a '
			+ 'feature branch cannot hand everyone else a view of its half-built state.',
		)
		return null
	}
	const files = impactedTestFiles(result.scenarios)
	console.error(`[opice] ${label}: ${paths.length} changed path(s) against ${base} → ${result.scenarios.length} scenario(s) in ${files.length} file(s).`)
	for (const scenario of result.scenarios) console.error(`[opice]   ${explainSelection(scenario)}`)
	// A populated index is not necessarily a COMPLETE one: a scenario that has
	// never finished a footprint run has no edges, so a change touching only that
	// scenario matches nothing and looks exactly like "nothing is affected". Say
	// which it is — the selection still only adds, so this is a warning, not a
	// refusal, but an empty answer from a partial index shouldn't read as certain.
	if (result.index.unindexed > 0 && result.scenarios.length === 0) {
		warn(
			`${label}: ${result.index.unindexed} known scenario(s) have no footprint yet, so this empty answer `
			+ 'may mean "unknown" rather than "nothing is affected". Re-run the suite with `opice test --footprint` '
			+ 'on the default branch to close the gap.',
		)
	}
	return { base, paths, files, result }
}

function warn(message: string): void {
	console.error(`[opice] warning: ${message}`)
}
