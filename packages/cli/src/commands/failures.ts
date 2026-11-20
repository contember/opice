/**
 * `opice failures <run-url|run-id>` — pull a failed run's details from the
 * platform and print a digest the re-eval workflow can act on: which
 * scenarios failed, at which step, the error, the screenshot URL, and the
 * source test file that produced them (the test is the spec — each step
 * carries its `intent`, so there's no separate scenario file).
 *
 * Two read modes:
 *   - SERVICE KEY (OPICE_READ_DSN): a px_ key holding report.read in the project →
 *     the machine reads (`/machine/reads.*`), with the run id from the URL or argument.
 *   - SHARE LINK: a pasted share link `<origin>/s/#<key>` (or its key in OPICE_READ_TOKEN)
 *     → the link mount's procedures, which read the link's own run.
 *
 * A screenshot answers only with that key as a bearer token, so `--screenshots <dir>` downloads each failed step's
 * picture with it and prints the local path.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config'
import { parseOpiceDsn } from '../dsn'

interface Run {
	id: string
	branch: string | null
	commitSha: string | null
	status: string
	totalScenarios: number
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
	id: string
	sequence: number
	name: string
	status: string
	error: string | null
	screenshotUrl: string | null
}

interface Target {
	endpoint: string
	auth: { kind: 'machine'; key: string; runId: string } | { kind: 'link'; key: string }
}

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const textOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null
const count = (value: unknown): number => typeof value === 'number' ? value : 0

function parseRun(value: unknown): Run {
	if (!isFields(value)) throw new Error('the platform answered no run')
	return {
		id: text(value['id']),
		branch: textOrNull(value['branch']),
		commitSha: textOrNull(value['commitSha']),
		status: text(value['status']),
		totalScenarios: count(value['totalScenarios']),
		failedScenarios: count(value['failedScenarios']),
	}
}

function parseList<T>(value: unknown, field: string, parse: (item: Fields) => T): T[] {
	const list = isFields(value) ? value[field] : undefined
	if (!Array.isArray(list)) throw new Error(`the platform answered no ${field}`)
	return list.filter(isFields).map(parse)
}

const parseScenario = (item: Fields): Scenario => ({
	id: text(item['id']),
	name: text(item['name']),
	hash: textOrNull(item['hash']),
	testFile: textOrNull(item['testFile']),
	scenarioFile: textOrNull(item['scenarioFile']),
	status: text(item['status']),
})

const parseStep = (item: Fields): Step => ({
	id: text(item['id']),
	sequence: count(item['sequence']),
	name: text(item['name']),
	status: text(item['status']),
	error: textOrNull(item['error']),
	screenshotUrl: textOrNull(item['screenshotUrl']),
})

interface Failure {
	scenario: Scenario
	steps: Step[]
	/** Local file per failed step id, when --screenshots downloaded it. */
	files: Map<string, string>
}

export async function failuresCommand(args: string[]): Promise<number> {
	const asJson = args.includes('--json')
	const shotsAt = args.indexOf('--screenshots')
	const shotsDir = shotsAt >= 0 ? args[shotsAt + 1] : undefined
	const positional = args.filter((a, i) => !a.startsWith('--') && !(shotsAt >= 0 && i === shotsAt + 1))
	const ref = positional[0]
	if (!ref || (shotsAt >= 0 && !shotsDir)) {
		console.error('Usage: opice failures <run-url|run-id> [--json] [--screenshots <dir>]')
		return 1
	}

	const target = await resolveTarget(ref)
	if (!target) {
		console.error('Could not determine the platform endpoint or a read credential. Pass a share link or a run URL with OPICE_READ_DSN set, or run `opice` from a project with opice.config.json.')
		return 1
	}

	let run: Run
	let scenarios: Scenario[]
	try {
		run = parseRun(await read(target, target.auth.kind === 'machine' ? ['/machine/reads.run', { runId: target.auth.runId }] : ['/s/api/run', {}]))
		scenarios = parseList(await read(target, target.auth.kind === 'machine' ? ['/machine/reads.scenarios', { runId: target.auth.runId }] : ['/s/api/scenarios', {}]), 'scenarios', parseScenario)
	} catch (err) {
		console.error(`[opice] ${err instanceof Error ? err.message : String(err)}`)
		return 1
	}

	const failures: Failure[] = await Promise.all(
		scenarios.filter((s) => s.status === 'failed').map(async (scenario) => {
			const call: [string, Fields] = target.auth.kind === 'machine'
				? ['/machine/reads.steps', { runId: target.auth.runId, scenarioId: scenario.id }]
				: ['/s/api/steps', { scenarioId: scenario.id }]
			const steps = await read(target, call).then((answer) => parseList(answer, 'steps', parseStep)).catch((): Step[] => [])
			return { scenario, steps, files: new Map<string, string>() }
		}),
	)

	if (shotsDir) await downloadScreenshots(failures, target, shotsDir)

	if (asJson) {
		console.log(JSON.stringify({ run, failures: failures.map((f) => digestEntry(f, target)) }, null, 2))
		return 0
	}

	printDigest(run, failures, target)
	return 0
}

async function downloadScreenshots(failures: Failure[], target: Target, dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true })
	for (const [index, failure] of failures.entries()) {
		for (const step of failure.steps) {
			if (step.status !== 'failed' || !step.screenshotUrl) continue
			const file = path.join(dir, `${index + 1}-step-${step.sequence + 1}.png`)
			const response = await fetch(absoluteScreenshot(step.screenshotUrl, target), {
				headers: { authorization: `Bearer ${target.auth.key}` },
			}).catch(() => null)
			if (!response?.ok) {
				console.error(`[opice] screenshot of "${step.name}" not downloaded (${response ? response.status : 'network error'})`)
				continue
			}
			await fs.writeFile(file, new Uint8Array(await response.arrayBuffer()))
			failure.files.set(step.id, file)
		}
	}
}

function digestEntry(failure: Failure, target: Target) {
	const failedSteps = failure.steps.filter((s) => s.status === 'failed')
	return {
		name: failure.scenario.name,
		hash: failure.scenario.hash,
		testFile: failure.scenario.testFile,
		scenarioFile: failure.scenario.scenarioFile,
		stepCount: failure.steps.length,
		failedSteps: failedSteps.map((s) => ({
			sequence: s.sequence,
			name: s.name,
			error: s.error,
			screenshot: s.screenshotUrl ? absoluteScreenshot(s.screenshotUrl, target) : null,
			screenshotFile: failure.files.get(s.id) ?? null,
		})),
	}
}

function printDigest(run: Run, failures: Failure[], target: Target): void {
	const out: string[] = []
	out.push(`Run ${run.id} — ${run.status.toUpperCase()}`)
	const meta = [run.branch, run.commitSha ? `commit ${run.commitSha.slice(0, 7)}` : null].filter(Boolean).join(' · ')
	if (meta) out.push(meta)
	out.push(`${run.failedScenarios}/${run.totalScenarios} scenarios failed`)
	out.push('')

	if (failures.length === 0) {
		out.push('No failed scenarios recorded for this run.')
		console.log(out.join('\n'))
		return
	}

	for (const { scenario, steps, files } of failures) {
		const failedSteps = steps.filter((s) => s.status === 'failed')
		out.push(`✗ ${scenario.name}${scenario.hash ? `  [#${scenario.hash}]` : ''}`)
		if (scenario.testFile) out.push(`  test:     ${scenario.testFile}`)
		if (scenario.scenarioFile) out.push(`  scenario: ${scenario.scenarioFile}`)
		for (const s of failedSteps) {
			out.push(`  failed at step ${s.sequence + 1}/${steps.length}: "${s.name}"`)
			if (s.error) {
				for (const line of s.error.split('\n')) out.push(`    ${line}`)
			}
			const file = files.get(s.id)
			if (file) out.push(`    screenshot: ${file}`)
			else if (s.screenshotUrl) out.push(`    screenshot: ${absoluteScreenshot(s.screenshotUrl, target)} (needs the key as a bearer token; use --screenshots <dir>)`)
		}
		out.push('')
	}
	console.log(out.join('\n').trimEnd())
}

function absoluteScreenshot(relativeOrAbsolute: string, target: Target): string {
	return relativeOrAbsolute.startsWith('http') ? relativeOrAbsolute : `${target.endpoint}${relativeOrAbsolute}`
}

async function resolveTarget(ref: string): Promise<Target | null> {
	const readDsn = parseOpiceDsn(process.env['OPICE_READ_DSN'])
	const envShareKey = process.env['OPICE_READ_TOKEN']

	if (/^https?:\/\//.test(ref)) {
		const url = new URL(ref)
		// A share link is `<origin>/s/#<key>`: the key names its run.
		const linkKey = url.pathname.startsWith('/s') ? url.hash.slice(1) : ''
		if (linkKey) return { endpoint: url.origin, auth: { kind: 'link', key: decodeURIComponent(linkKey) } }
		const match = url.pathname.match(/\/r\/([^/]+)/)
		const runId = match ? decodeURIComponent(match[1]!) : url.pathname.split('/').filter(Boolean).pop()
		if (!runId) return null
		if (envShareKey) return { endpoint: url.origin, auth: { kind: 'link', key: envShareKey } }
		return readDsn ? { endpoint: url.origin, auth: { kind: 'machine', key: readDsn.key, runId } } : null
	}

	// Bare run id — endpoint from config/env/DSN, auth from the read DSN.
	const config = await loadConfig()
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint ?? readDsn?.endpoint ?? parseOpiceDsn(process.env['OPICE_DSN'])?.endpoint
	if (!endpoint || !readDsn) return null
	return { endpoint, auth: { kind: 'machine', key: readDsn.key, runId: ref } }
}

/** Calls one read procedure with the target's key as a bearer token and answers its `result`. */
async function read(target: Target, [procedurePath, input]: [string, Fields]): Promise<unknown> {
	const response = await fetch(`${target.endpoint}${procedurePath}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${target.auth.key}`, 'content-type': 'application/json' },
		body: JSON.stringify(input),
	})
	const answer: unknown = await response.json().catch(() => null)
	if (!response.ok || !isFields(answer) || !('result' in answer)) {
		const error = isFields(answer) && isFields(answer['error']) ? text(answer['error']['message']) : ''
		throw new Error(`${procedurePath}: ${response.status} ${error || response.statusText}`)
	}
	return answer['result']
}
