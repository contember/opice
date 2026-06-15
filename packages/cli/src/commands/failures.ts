/**
 * `opice failures <run-url|run-id>` — pull a failed run's details from the
 * platform and print a digest the re-eval workflow can act on: which
 * scenarios failed, at which step, the error, the screenshot URL, and the
 * source test file that produced them (the test is the spec — each step
 * carries its `intent`, so there's no separate scenario file).
 *
 * Two read modes:
 *   - SERVICE TOKEN (OPICE_READ_DSN): a propustka service-token principal → REST
 *     GET /api/v1/<slug>/… with the CF-Access-Client-* headers.
 *   - CAPABILITY SHARE: a pasted dashboard link's `?token=` (or OPICE_READ_TOKEN)
 *     → the anonymous read RPC at /s/rpc.
 */

import { loadConfig } from '../config'
import { parseOpiceDsn } from '../dsn'

interface Run {
	id: string
	branch: string | null
	commitSha: string | null
	status: string
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
}

interface Scenario {
	id: string
	name: string
	hash: string | null
	testFile: string | null
	scenarioFile: string | null
	status: string
}

interface Step {
	id: number
	sequence: number
	name: string
	status: string
	error: string | null
	screenshotUrl: string | null
}

interface Target {
	endpoint: string
	runId: string
	slug?: string
	// Exactly one auth mode: a pasted share link / OPICE_READ_TOKEN is a capability on /s/rpc;
	// OPICE_READ_DSN is a service token (CF-Access-Client-*) on /api/v1.
	shareToken?: string
	service?: { clientId: string; clientSecret: string }
}

type ReadOp =
	| { kind: 'run'; runId: string }
	| { kind: 'scenarios'; runId: string }
	| { kind: 'steps'; scenarioId: string }

export async function failuresCommand(args: string[]): Promise<number> {
	const asJson = args.includes('--json')
	const positional = args.filter((a) => !a.startsWith('--'))
	const ref = positional[0]
	if (!ref) {
		console.error('Usage: opice failures <run-url|run-id> [--json]')
		return 1
	}

	const target = await resolveTarget(ref)
	if (!target) {
		console.error('Could not determine the platform endpoint. Pass a full run URL or run `opice` from a project with opice.config.json.')
		return 1
	}

	let run: Run
	let scenarios: Scenario[]
	try {
		run = await read<Run>(target, { kind: 'run', runId: target.runId })
		scenarios = await read<Scenario[]>(target, { kind: 'scenarios', runId: target.runId })
	} catch (err) {
		console.error(`[opice] ${(err as Error).message}`)
		return 1
	}

	const failed = scenarios.filter((s) => s.status === 'failed')
	const detailed = await Promise.all(
		failed.map(async (s) => ({
			scenario: s,
			steps: await read<Step[]>(target, { kind: 'steps', scenarioId: s.id }).catch(() => [] as Step[]),
		})),
	)

	if (asJson) {
		console.log(JSON.stringify({ run, failures: detailed.map((d) => digestEntry(d, target)) }, null, 2))
		return 0
	}

	printDigest(run, detailed, target)
	return 0
}

function digestEntry(d: { scenario: Scenario; steps: Step[] }, target: Target) {
	const failedSteps = d.steps.filter((s) => s.status === 'failed')
	return {
		name: d.scenario.name,
		hash: d.scenario.hash,
		testFile: d.scenario.testFile,
		scenarioFile: d.scenario.scenarioFile,
		stepCount: d.steps.length,
		failedSteps: failedSteps.map((s) => ({
			sequence: s.sequence,
			name: s.name,
			error: s.error,
			screenshot: s.screenshotUrl ? absoluteScreenshot(s.screenshotUrl, target) : null,
		})),
	}
}

function printDigest(run: Run, detailed: { scenario: Scenario; steps: Step[] }[], target: Target): void {
	const out: string[] = []
	out.push(`Run ${run.id} — ${run.status.toUpperCase()}`)
	const meta = [run.branch, run.commitSha ? `commit ${run.commitSha.slice(0, 7)}` : null].filter(Boolean).join(' · ')
	if (meta) out.push(meta)
	out.push(`${run.failedScenarios}/${run.totalScenarios} scenarios failed`)
	out.push('')

	if (detailed.length === 0) {
		out.push('No failed scenarios recorded for this run.')
		console.log(out.join('\n'))
		return
	}

	for (const { scenario, steps } of detailed) {
		const failedSteps = steps.filter((s) => s.status === 'failed')
		out.push(`✗ ${scenario.name}${scenario.hash ? `  [#${scenario.hash}]` : ''}`)
		if (scenario.testFile) out.push(`  test:     ${scenario.testFile}`)
		if (scenario.scenarioFile) out.push(`  scenario: ${scenario.scenarioFile}`)
		for (const s of failedSteps) {
			out.push(`  failed at step ${s.sequence + 1}/${steps.length}: "${s.name}"`)
			if (s.error) {
				for (const line of s.error.split('\n')) out.push(`    ${line}`)
			}
			if (s.screenshotUrl) out.push(`    screenshot: ${absoluteScreenshot(s.screenshotUrl, target)}`)
		}
		out.push('')
	}
	console.log(out.join('\n').trimEnd())
}

function absoluteScreenshot(relativeOrAbsolute: string, target: Target): string {
	const base = relativeOrAbsolute.startsWith('http') ? relativeOrAbsolute : `${target.endpoint}${relativeOrAbsolute}`
	// A share link can carry its token in the URL; a service token needs headers, so leave it bare.
	if (!target.shareToken) return base
	return `${base}${base.includes('?') ? '&' : '?'}token=${target.shareToken}`
}

async function resolveTarget(ref: string): Promise<Target | null> {
	const readDsn = parseOpiceDsn(process.env['OPICE_READ_DSN'])
	const service = readDsn ? { clientId: readDsn.clientId, clientSecret: readDsn.clientSecret } : undefined
	const envShareToken = process.env['OPICE_READ_TOKEN']

	if (/^https?:\/\//.test(ref)) {
		const url = new URL(ref)
		const urlToken = url.searchParams.get('token')
		const match = url.pathname.match(/\/p\/([^/]+)\/r\/([^/]+)/)
		const slug = match ? decodeURIComponent(match[1]!) : (process.env['OPICE_PROJECT'] ?? readDsn?.project)
		const runId = match ? decodeURIComponent(match[2]!) : url.pathname.split('/').filter(Boolean).pop()
		if (!runId) return null
		// A pasted share link (?token=) or OPICE_READ_TOKEN → capability; otherwise the read DSN.
		const shareToken = urlToken ?? envShareToken
		if (shareToken) return { endpoint: url.origin, runId, slug, shareToken }
		return { endpoint: url.origin, runId, slug, service }
	}

	// Bare run id — endpoint + slug from config/env/DSN, auth from the read DSN or OPICE_READ_TOKEN.
	const config = await loadConfig()
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint ?? readDsn?.endpoint ?? parseOpiceDsn(process.env['OPICE_DSN'])?.endpoint
	if (!endpoint) return null
	const slug = process.env['OPICE_PROJECT'] ?? config?.project ?? readDsn?.project
	if (envShareToken) return { endpoint, runId: ref, slug, shareToken: envShareToken }
	return { endpoint, runId: ref, slug, service }
}

/**
 * Read one resource, routed by the target's auth mode: a service token → REST GET on /api/v1
 * (which needs the project slug); a capability share token → the /s/rpc read RPC.
 */
async function read<T>(target: Target, op: ReadOp): Promise<T> {
	if (target.service) {
		if (!target.slug) {
			throw new Error('reading via OPICE_READ_DSN needs the project slug — paste a full run URL or set OPICE_PROJECT')
		}
		const path = op.kind === 'run'
			? `runs/${op.runId}`
			: op.kind === 'scenarios'
				? `runs/${op.runId}/scenarios`
				: `scenarios/${op.scenarioId}/steps`
		const response = await fetch(`${target.endpoint}/api/v1/${target.slug}/${path}`, {
			headers: {
				'cf-access-client-id': target.service.clientId,
				'cf-access-client-secret': target.service.clientSecret,
			},
		})
		if (!response.ok) {
			throw new Error(`${op.kind}: ${response.status} ${response.statusText}`)
		}
		return (await response.json()) as T
	}

	// Capability share → the anonymous read RPC.
	const method = op.kind === 'run' ? 'runs.get' : op.kind === 'scenarios' ? 'runs.scenarios' : 'scenarios.steps'
	const input = op.kind === 'steps' ? { scenarioId: op.scenarioId } : { runId: op.runId }
	const url = `${target.endpoint}/s/rpc${target.shareToken ? `?token=${target.shareToken}` : ''}`
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input }),
	})
	const data = (await response.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null
	if (!data) throw new Error(`${method}: ${response.status} ${response.statusText}`)
	if (data.error) throw new Error(`${method}: ${data.error.message ?? 'request failed'}`)
	return data.result as T
}
