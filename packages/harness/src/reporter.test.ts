import { afterEach, beforeEach, expect, test } from 'bun:test'
import { configureFromEnv, type Reporter, type ScenarioStart } from './reporter.js'

let server: ReturnType<typeof Bun.serve> | undefined
let handler: (req: Request) => Response

const ok = () => Response.json({ runId: 'run-1', scenarioId: 'scenario-1' })

/** An HttpReporter pointed at the local server — reporting forced on, as in CI. */
function reporterAgainst(host: string): Reporter {
	return configureFromEnv({ OPICE_DSN: `http://id:secret@${host}/proj`, OPICE_REPORT: 'always' })
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
		if (!new URL(req.url).pathname.endsWith('/runs')) return ok()
		runAttempts++
		return runAttempts === 1 ? new Response('busy', { status: 503 }) : ok()
	}
	const reporter = serving()
	await reporter.startScenario(scenario)
	expect(runAttempts).toBe(2)
	expect(reporter.reportingFailed()).toBe(false)
})

test('a lost step leaves a run the platform is otherwise recording green', async () => {
	handler = (req) => new URL(req.url).pathname.endsWith('/steps') ? new Response('nope', { status: 503 }) : ok()
	const reporter = serving()
	const scenarioId = await reporter.startScenario(scenario)
	// Resolves rather than rejects — a discarded rejection would reach bun as an
	// unhandled error and red the test file over a dropped report.
	await reporter.recordStep({ scenarioId, sequence: 0, name: 'a step', status: 'passed', durationMs: 1 })
	expect(reporter.reportingFailed()).toBe(false)
}, 15_000)

test('a service token rejected at the Access edge fails reporting at once', async () => {
	handler = () => new Response(null, { status: 302, headers: { location: 'https://acme.cloudflareaccess.com/cdn-cgi/access/login' } })
	const reporter = serving()
	await expect(reporter.startScenario(scenario)).rejects.toThrow()
	expect(reporter.reportingFailed()).toBe(true)
})

test('a platform that records nothing at all fails reporting once retries are spent', async () => {
	const reporter = reporterAgainst(closedHost())
	await expect(reporter.startScenario(scenario)).rejects.toThrow()
	expect(reporter.reportingFailed()).toBe(true)
}, 15_000)
