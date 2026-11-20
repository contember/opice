import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { configureFromEnv, type Reporter, type ScenarioStart } from './reporter.js'

let server: ReturnType<typeof Bun.serve> | undefined
let handler: (req: Request) => Response | Promise<Response>

const ok = () => Response.json({ result: { runId: 'run-1', scenarioId: 'scenario-1' } })

/** An HttpReporter pointed at the local server — reporting forced on, as in CI. */
function reporterAgainst(host: string): Reporter {
	return configureFromEnv({ OPICE_DSN: `http://px_test@${host}/proj`, OPICE_REPORT: 'always' })
}

function serving(): Reporter {
	server = Bun.serve({ port: 0, fetch: (req) => handler(req) })
	return reporterAgainst(server.url.host)
}

/** A host nothing listens on: bind a port, hand it back, let it go. */
function closedHost(): string {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
	const host = probe.url.host
	probe.stop(true)
	return host
}

const scenario: ScenarioStart = { name: 'Example scenario' }

beforeEach(() => {
	handler = ok
})
afterEach(() => {
	server?.stop(true)
	server = undefined
	configureFromEnv({})
})

test('a report that goes through leaves reporting healthy', async () => {
	const reporter = serving()
	await reporter.startScenario(scenario)
	expect(reporter.reportingFailed()).toBe(false)
})

test('a transient failure that clears on retry is not a failure at all', async () => {
	let runAttempts = 0
	handler = (req) => {
		if (new URL(req.url).pathname !== '/machine/reports.startRun') return ok()
		runAttempts++
		return runAttempts === 1 ? new Response('busy', { status: 503 }) : ok()
	}
	const reporter = serving()
	await reporter.startScenario(scenario)
	expect(runAttempts).toBe(2)
	expect(reporter.reportingFailed()).toBe(false)
})

test('a lost step leaves a run the platform is otherwise recording green', async () => {
	handler = (req) => new URL(req.url).pathname === '/machine/reports.step' ? new Response('nope', { status: 503 }) : ok()
	const reporter = serving()
	const scenarioId = await reporter.startScenario(scenario)
	// Resolves rather than rejects — a discarded rejection would reach bun as an
	// unhandled error and red the test file over a dropped report.
	await reporter.recordStep({ scenarioId, sequence: 0, name: 'a step', status: 'passed', durationMs: 1 })
	expect(reporter.reportingFailed()).toBe(false)
}, 15_000)

test('each report goes to its machine procedure with the service key as a bearer token', async () => {
	const seen: { path: string; authorization: string | null }[] = []
	handler = (req) => {
		seen.push({ path: new URL(req.url).pathname, authorization: req.headers.get('authorization') })
		return ok()
	}
	const reporter = serving()
	await reporter.startScenario(scenario)
	expect(seen.map((call) => call.path)).toEqual(['/machine/reports.startRun', '/machine/reports.startScenario'])
	expect(seen.every((call) => call.authorization === 'Bearer px_test')).toBe(true)
})

test('a step whose screenshot upload fails is recorded without it, marked', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'opice-reporter-'))
	const screenshotPath = path.join(dir, 'step.png')
	writeFileSync(screenshotPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
	const steps: { multipart: boolean; input: unknown }[] = []
	handler = async (req) => {
		if (new URL(req.url).pathname !== '/machine/reports.step') return ok()
		if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
			const form = await req.formData()
			steps.push({ multipart: true, input: JSON.parse(String(form.get('input'))) })
			return new Response('refused', { status: 415 })
		}
		steps.push({ multipart: false, input: await req.json() })
		return ok()
	}
	const reporter = serving()
	const scenarioId = await reporter.startScenario(scenario)
	await reporter.recordStep({ scenarioId, sequence: 0, name: 'a step', status: 'passed', durationMs: 1, screenshotPath })
	rmSync(dir, { recursive: true })
	expect(steps.map((step) => step.multipart)).toEqual([true, false])
	expect(steps[1]?.input).toMatchObject({ runId: 'run-1', scenarioId, name: 'a step', screenshotFailed: true })
	expect(reporter.reportingFailed()).toBe(false)
})

test('a DSN of the old platform (with a password) does not configure reporting', () => {
	const reporter = configureFromEnv({ OPICE_DSN: 'https://id:secret@example.com/proj', OPICE_REPORT: 'always' })
	expect(reporter.reportingFailed()).toBe(false)
	expect(reporter.constructor.name).toBe('NoopReporter')
})

test('a service key the platform refuses fails reporting at once', async () => {
	handler = () => new Response('invalid_key', { status: 401 })
	const reporter = serving()
	await expect(reporter.startScenario(scenario)).rejects.toThrow()
	expect(reporter.reportingFailed()).toBe(true)
})

test('a platform that records nothing at all fails reporting once retries are spent', async () => {
	const reporter = reporterAgainst(closedHost())
	await expect(reporter.startScenario(scenario)).rejects.toThrow()
	expect(reporter.reportingFailed()).toBe(true)
}, 15_000)
