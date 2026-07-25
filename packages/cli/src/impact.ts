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

import { parseOpiceDsn } from './dsn'
import { changedPaths, defaultBase } from './git'

/** How the platform describes its own index, so an empty answer can be explained. */
export interface ImpactIndexStatus {
	edges: number
	scenarios: number
	updatedAt: number | null
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
		return (await response.json()) as ImpactResult
	} catch (err) {
		console.error(`[opice] impact query failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

/** Test files of the impacted scenarios, deduplicated — what feeds `--select`. */
export function impactedTestFiles(scenarios: readonly ImpactedScenario[]): string[] {
	return [...new Set(scenarios.map((s) => s.testFile).filter((f): f is string => !!f))].sort()
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
	return { base, paths, files, result }
}

function warn(message: string): void {
	console.error(`[opice] warning: ${message}`)
}
