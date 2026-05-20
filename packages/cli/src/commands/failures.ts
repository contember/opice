/**
 * `opice failures <run-url|run-id>` — pull a failed run's details from the
 * platform and print a digest the re-eval workflow can act on: which
 * scenarios failed, at which step, the error, the screenshot URL, and the
 * source files (test + scenario.md) that produced them.
 *
 * Reads are token-gated. The token is taken from the URL's `?token=` (when you
 * paste a dashboard link) or from OPICE_READ_TOKEN.
 */

import { loadConfig } from '../config'

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
	token: string | undefined
	slug?: string
}

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
		run = await rpc<Run>(target, 'runs.get', { runId: target.runId })
		scenarios = await rpc<Scenario[]>(target, 'runs.scenarios', { runId: target.runId })
	} catch (err) {
		console.error(`[opice] ${(err as Error).message}`)
		return 1
	}

	const failed = scenarios.filter((s) => s.status === 'failed')
	const detailed = await Promise.all(
		failed.map(async (s) => ({
			scenario: s,
			steps: await rpc<Step[]>(target, 'scenarios.steps', { scenarioId: s.id }).catch(() => [] as Step[]),
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
	if (!target.token) return base
	return `${base}${base.includes('?') ? '&' : '?'}token=${target.token}`
}

async function resolveTarget(ref: string): Promise<Target | null> {
	if (/^https?:\/\//.test(ref)) {
		const url = new URL(ref)
		const token = url.searchParams.get('token') ?? process.env['OPICE_READ_TOKEN'] ?? undefined
		const match = url.pathname.match(/\/p\/([^/]+)\/r\/([^/]+)/)
		if (match) {
			return { endpoint: url.origin, runId: decodeURIComponent(match[2]!), token, slug: decodeURIComponent(match[1]!) }
		}
		// Fall back to the last path segment as the run id.
		const segments = url.pathname.split('/').filter(Boolean)
		const runId = segments[segments.length - 1]
		if (runId) return { endpoint: url.origin, runId, token }
		return null
	}

	// Bare run id — endpoint from config/env, token from env.
	const config = await loadConfig()
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint
	if (!endpoint) return null
	return { endpoint, runId: ref, token: process.env['OPICE_READ_TOKEN'] ?? undefined }
}

async function rpc<T>(target: Target, method: string, input: unknown): Promise<T> {
	const url = `${target.endpoint}/rpc${target.token ? `?token=${target.token}` : ''}`
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
