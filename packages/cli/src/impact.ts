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

import { execSync } from 'node:child_process'
import { parseOpiceDsn } from './dsn'

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
	reasons: ImpactReason[]
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

/**
 * The paths a branch changed, relative to `base`.
 *
 * Uses the three-dot form (`base...HEAD`), i.e. everything since the merge base
 * — the same set a PR shows. Uncommitted work is folded in too, so running this
 * locally mid-change selects the tests for what you're actually editing rather
 * than for your last commit.
 */
export function changedPaths(base: string): string[] {
	const paths = new Set<string>()
	for (const command of [
		`git diff --name-only ${shellQuote(base)}...HEAD`,
		'git diff --name-only HEAD',
		'git ls-files --others --exclude-standard',
	]) {
		for (const line of tryGit(command)) paths.add(line)
	}
	return [...paths]
}

/** The default base to diff against — the first of these refs that exists. */
export function defaultBase(): string {
	const candidates = [
		process.env['OPICE_IMPACT_BASE'],
		process.env['GITHUB_BASE_REF'] ? `origin/${process.env['GITHUB_BASE_REF']}` : undefined,
		'origin/main',
		'origin/master',
		'main',
		'master',
	].filter((c): c is string => !!c)
	for (const candidate of candidates) {
		if (tryGit(`git rev-parse --verify --quiet ${shellQuote(candidate)}`).length > 0) return candidate
	}
	return 'HEAD~1'
}

/** Ask the platform which scenarios a change reaches. Returns null when it can't be asked. */
export async function queryImpact(
	credentials: ImpactCredentials,
	input: { paths: string[]; models?: string[] },
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
			body: JSON.stringify({ paths: input.paths, models: input.models ?? [] }),
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
	const reasons = scenario.reasons.slice(0, 3).map((r) => `${r.kind} ${r.value}`)
	const extra = scenario.reasons.length > reasons.length ? ` (+${scenario.reasons.length - reasons.length} more)` : ''
	return `${scenario.scenarioName} — ${reasons.join(', ')}${extra}`
}

function tryGit(command: string): string[] {
	try {
		return execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}

/** Single-quote a ref for the shell. Refs can contain `/` and `-`, never a quote we'd need to escape. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}
