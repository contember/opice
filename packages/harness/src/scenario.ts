import { createRequire } from 'node:module'
import path from 'node:path'
import { closePage, getContext, launchPage } from './context.js'
import { screenshot } from './element.js'
import { getReporter } from './reporter.js'
import { loadUserSetup } from './setup.js'

/**
 * `bun:test` is resolved lazily, at the moment `browserTest` registers a
 * scenario — never at module load. That keeps `@opice/harness` importable
 * under plain Node (the `opice-browser` authoring daemon imports the command
 * registry from this package and runs on Node, where `bun:test` doesn't
 * exist). Tests still register synchronously: `require` is sync under Bun.
 */
const require = createRequire(import.meta.url)
function bunTest(): typeof import('bun:test') {
	return require('bun:test') as typeof import('bun:test')
}

const PLAYGROUND_URL = process.env['PLAYGROUND_URL'] ?? 'http://localhost:15180'

export interface BrowserTestOptions {
	/** Hash fragment appended to PLAYGROUND_URL (e.g. 'datagrid'). */
	hash?: string
	/** Override base URL (defaults to PLAYGROUND_URL env). */
	url?: string
	/**
	 * Path to the human-readable `*.scenario.md` this test was authored from.
	 * Reported to the platform so the re-eval workflow can find the source.
	 * If omitted, defaults to the test file path with `.test.ts` → `.scenario.md`.
	 */
	scenarioFile?: string
}

/**
 * Best-effort capture of the `*.test.ts` path that called `browserTest`, by
 * walking the stack for the first `.test.` frame. Reported so a failed
 * scenario links back to its source file. Repo-relative when possible.
 */
function captureTestFile(): string | undefined {
	const stack = new Error().stack
	if (!stack) return undefined
	for (const line of stack.split('\n')) {
		const match = line.match(/\(?((?:file:\/\/)?\/[^\s():]+\.test\.[tj]sx?)/)
		if (match?.[1]) {
			const abs = match[1].replace(/^file:\/\//, '')
			try {
				const rel = path.relative(process.cwd(), abs)
				return rel.startsWith('..') ? abs : rel
			} catch {
				return abs
			}
		}
	}
	return undefined
}

function defaultScenarioFile(testFile: string | undefined): string | undefined {
	if (!testFile) return undefined
	return testFile.replace(/\.test\.[tj]sx?$/, '.scenario.md')
}

let currentScenarioId: string | null = null
let currentScenarioStart: number = 0
let currentScenarioFailures = 0
// Monotonic per-scenario step counter. Assigned synchronously at each step()
// call so order reflects authoring order — step records are POSTed
// fire-and-forget and would otherwise be sequenced by arrival order at the
// worker, which screenshot-encoding latency can reshuffle.
let currentScenarioStepSeq = 0

/**
 * Register a top-level browser test scenario.
 *
 * Each `browserTest(name, fn)` launches its own isolated Playwright browser +
 * context + page, navigates to the playground URL, runs the given `fn` (which
 * typically contains nested `describe`/`test` blocks), and tears the browser
 * down in `afterAll`.
 */
export function browserTest(name: string, fn: () => void, options: BrowserTestOptions | string = {}): void {
	const opts: BrowserTestOptions = typeof options === 'string' ? { hash: options } : options
	const reporter = getReporter()
	const testFile = captureTestFile()
	const scenarioFile = opts.scenarioFile ?? defaultScenarioFile(testFile)
	const { describe, beforeAll, afterAll } = bunTest()

	describe(name, () => {
		beforeAll(async () => {
			currentScenarioStart = Date.now()
			currentScenarioFailures = 0
			currentScenarioStepSeq = 0
			try {
				currentScenarioId = await reporter.startScenario({ name, hash: opts.hash, testFile, scenarioFile })
			} catch {
				currentScenarioId = null
			}
			const page = await launchPage()
			// Repo-level context setup (browser-setup.ts) runs before the first
			// navigation, so an addInitScript it registers fires before the app's
			// own scripts on first paint.
			const setup = await loadUserSetup()
			if (setup) await setup(getContext())
			const base = opts.url ?? PLAYGROUND_URL
			const url = opts.hash ? `${base}#${opts.hash}` : base
			// `domcontentloaded`, not the default `load`: an SPA paints after its JS
				// runs and may hold `load` on a slow chunk or long-lived connection, so
				// waiting for `load` flakily times out under CI contention. Readiness is
				// handled by the test's retrying assertions.
				await page.goto(url, { waitUntil: 'domcontentloaded' })
		}, 30_000)

		afterAll(async () => {
			try {
				await closePage()
			} catch {
				// ignore close errors
			}
			if (currentScenarioId) {
				// Drain pending step records (incl. their screenshot uploads)
				// before marking the scenario done. step() fires recordStep
				// fire-and-forget; the test process would otherwise exit while
				// those requests were still in flight.
				try {
					await reporter.flush()
				} catch {
					// best-effort
				}
				const durationMs = Date.now() - currentScenarioStart
				const status = currentScenarioFailures > 0 ? 'failed' : 'passed'
				try {
					await reporter.finishScenario({ scenarioId: currentScenarioId, status, durationMs })
				} catch {
					// best-effort
				}
			}
			currentScenarioId = null
		}, 30_000)

		fn()
	})
}

/**
 * A reportable step inside a scenario. Captures duration + screenshot on
 * finish, forwards to the active reporter (no-op unless configured via env).
 *
 * The body may be sync or async; `step` always returns a promise, so call it
 * with `await step('…', async () => { … })`.
 */
export async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
	const reporter = getReporter()
	// Capture order at call time, before the fire-and-forget record below.
	const sequence = currentScenarioStepSeq++
	const start = Date.now()
	let status: 'passed' | 'failed' = 'passed'
	let error: string | undefined
	try {
		await fn()
	} catch (e) {
		status = 'failed'
		error = e instanceof Error ? e.message : String(e)
		currentScenarioFailures++
		throw e
	} finally {
		const durationMs = Date.now() - start
		let screenshotPath: string | undefined
		try {
			screenshotPath = await screenshot()
		} catch {
			// screenshot failure shouldn't fail the test
		}
		if (currentScenarioId) {
			void reporter.recordStep({
				scenarioId: currentScenarioId,
				sequence,
				name,
				status,
				durationMs,
				error,
				screenshotPath,
			})
		}
	}
}
