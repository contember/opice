import { describe, beforeAll, afterAll } from 'bun:test'
import crypto from 'node:crypto'
import { exec, setSession } from './agent-browser.js'
import { waitFor, screenshot } from './element.js'
import { getReporter } from './reporter.js'

const PLAYGROUND_URL = process.env['PLAYGROUND_URL'] ?? 'http://localhost:15180'

export interface BrowserTestOptions {
	/** Hash fragment appended to PLAYGROUND_URL (e.g. 'datagrid'). */
	hash?: string
	/** Override base URL (defaults to PLAYGROUND_URL env). */
	url?: string
}

let currentScenarioId: string | null = null
let currentScenarioStart: number = 0
let currentScenarioFailures = 0

/**
 * Register a top-level browser test scenario.
 *
 * Each `browserTest(name, fn)` opens its own agent-browser session, navigates
 * to the playground URL, runs the given `fn` (which typically contains nested
 * `describe`/`test` blocks), and closes the session in `afterAll`.
 */
export function browserTest(name: string, fn: () => void, options: BrowserTestOptions | string = {}): void {
	const opts: BrowserTestOptions = typeof options === 'string' ? { hash: options } : options
	const reporter = getReporter()

	describe(name, () => {
		beforeAll(async () => {
			const session = `opice-${crypto.randomUUID().slice(0, 8)}`
			setSession(session)
			currentScenarioStart = Date.now()
			currentScenarioFailures = 0
			try {
				currentScenarioId = await reporter.startScenario({ name, hash: opts.hash })
			} catch {
				currentScenarioId = null
			}
			const base = opts.url ?? PLAYGROUND_URL
			const url = opts.hash ? `${base}#${opts.hash}` : base
			exec(`agent-browser open ${url}`)
			waitFor(() => {
				try {
					return exec('agent-browser get title').length > 0
				} catch {
					return false
				}
			}, { timeout: 15_000 })
		}, 30_000)

		afterAll(async () => {
			try {
				exec('agent-browser close')
			} catch {
				// ignore close errors
			}
			setSession(null)
			if (currentScenarioId) {
				const durationMs = Date.now() - currentScenarioStart
				const status = currentScenarioFailures > 0 ? 'failed' : 'passed'
				try {
					await reporter.finishScenario({ scenarioId: currentScenarioId, status, durationMs })
				} catch {
					// best-effort
				}
			}
			currentScenarioId = null
		}, 15_000)

		fn()
	})
}

/**
 * A reportable step inside a scenario. Captures duration + screenshot on
 * finish, forwards to the active reporter (no-op unless configured via env).
 */
export function step(name: string, fn: () => void): void {
	const reporter = getReporter()
	const start = Date.now()
	let status: 'passed' | 'failed' = 'passed'
	let error: string | undefined
	try {
		fn()
	} catch (e) {
		status = 'failed'
		error = e instanceof Error ? e.message : String(e)
		currentScenarioFailures++
		throw e
	} finally {
		const durationMs = Date.now() - start
		let screenshotPath: string | undefined
		try {
			screenshotPath = screenshot()
		} catch {
			// screenshot failure shouldn't fail the test
		}
		if (currentScenarioId) {
			void reporter.recordStep({
				scenarioId: currentScenarioId,
				name,
				status,
				durationMs,
				error,
				screenshotPath,
			})
		}
	}
}
