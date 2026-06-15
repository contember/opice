/**
 * Reporter — streams scenario/step/screenshot events to the opice platform.
 *
 * Steps are fire-and-forget (tracked in a pending queue so flush awaits
 * them). Scenario create + finish are awaited inline so the platform sees
 * the right status when the test process exits.
 *
 * The CLI handles end-of-run finalization: the reporter writes a
 * handoff file under $TMPDIR with the runId and credentials, the
 * `opice test` wrapper picks it up after `bun test` exits and POSTs
 * /api/v1/<slug>/runs/<id>/finish so the dashboard sees the run as completed.
 *
 * When env vars aren't configured, the reporter falls back to a no-op so
 * harness behavior matches the bindx prototype.
 */

import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseOpiceDsn } from './dsn.js'
import { resolveSelectedTier } from './tier.js'

/** Per-request cap, so a hung connection can't stall a scenario's afterAll. */
const REQUEST_TIMEOUT_MS = 10_000
/** Total cap on `flush()` waiting for pending step uploads (afterAll-bounded). */
const FLUSH_BUDGET_MS = 15_000

export interface ReporterConfig {
	endpoint: string
	projectId: string
	/** Service-token credentials (the OPICE_DSN userinfo / OPICE_CLIENT_ID+SECRET). */
	clientId: string
	clientSecret: string
	branch?: string
	commit?: string
	/** 'ci' for runs from automation, 'local' for opted-in dev runs. */
	source?: 'ci' | 'local'
	/**
	 * The tier this run SELECTED (from `OPICE_TIER`) — recorded on the run so the
	 * dashboard can explain why scenarios were skipped. Omitted when no tier
	 * filter was set (the run ran everything).
	 */
	tier?: string
}

export interface StepEvent {
	scenarioId: string
	/**
	 * 0-based retry attempt that produced this step. The platform shows only the
	 * final attempt's steps; earlier attempts are kept for forensics. Defaults
	 * to 0 on the platform side when omitted (older clients).
	 */
	attempt?: number
	/** Authoring order within the scenario, assigned at step() call time. */
	sequence: number
	/**
	 * 'step' (a procedural step) or 'invariant' (a scenario-level acceptance).
	 * The platform may render invariants distinctly; older workers ignore it.
	 */
	kind?: 'step' | 'invariant'
	name: string
	/**
	 * 'fixme' (a step.fixme that failed, as expected) and 'fixmepass' (a
	 * step.fixme that unexpectedly passed) are tolerated warnings — neither
	 * fails the scenario. 'pending' is a phase-1 stub that never ran (no body
	 * yet); a scenario carrying one reads as 'incomplete'.
	 */
	status: 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
	durationMs: number
	error?: string
	/**
	 * Durable rationale carried from the unit's contract (phase-1 `intent`) —
	 * why it exists / what it proves. Surfaced on the dashboard.
	 */
	intent?: string
	/**
	 * Human-readable manual line carried from the unit's contract — the
	 * plain-language, stupid-simple instruction (target language, formal
	 * register) for a non-technical reader. Stored now; not yet displayed.
	 */
	manual?: string
	/** Mandatory note from .fixme — why the failure is tolerated. */
	reason?: string
	screenshotPath?: string
}

export interface ScenarioStart {
	name: string
	hash?: string
	testFile?: string
	/** Requirement / feature id this scenario covers (grouping). */
	feature?: string
	/** Seeds required for the scenario (machine-checkable preconditions). */
	seeds?: string[]
	/** Identities / roles the scenario acts as. */
	roles?: string[]
	/** Declared tier (critical | standard | extended) — when it runs. */
	tier?: string
}

/**
 * A scenario the tier filter excluded from this run — registered for the record
 * but never executed. Reported `skipped`, carrying a `reason` (which tier it
 * declared vs the selected one) so the dashboard can explain the absence.
 */
export interface ScenarioSkip extends ScenarioStart {
	reason?: string
}

export interface ScenarioFinish {
	scenarioId: string
	status: 'passed' | 'failed'
	durationMs: number
	/**
	 * Total attempts the scenario took (>= 1). A passed scenario with
	 * `attempts > 1` is flaky. Omitted ⇒ the platform defaults it to 1.
	 */
	attempts?: number
}

export interface Reporter {
	startScenario(input: ScenarioStart): Promise<string>
	/** Record a scenario the tier filter skipped (created already-finished as `skipped`). */
	skipScenario(input: ScenarioSkip): Promise<void>
	recordStep(event: StepEvent): Promise<void>
	finishScenario(input: ScenarioFinish): Promise<void>
	flush(): Promise<void>
}

class NoopReporter implements Reporter {
	async startScenario(input: ScenarioStart): Promise<string> {
		return `noop-${input.name}-${Date.now()}`
	}
	async skipScenario(_input: ScenarioSkip): Promise<void> {}
	async recordStep(_event: StepEvent): Promise<void> {}
	async finishScenario(_input: ScenarioFinish): Promise<void> {}
	async flush(): Promise<void> {}
}

export const HANDOFF_DIR = path.join(tmpdir(), 'opice-handoffs')

function handoffPath(pid = process.pid): string {
	return path.join(HANDOFF_DIR, `${pid}.json`)
}

export interface RunHandoff {
	endpoint: string
	/** Project slug — the CLI builds /api/v1/<project>/runs/<id>/finish from it. */
	project: string
	/** Service-token credentials so the CLI can POST /finish with the CF-Access-Client-* headers. */
	clientId: string
	clientSecret: string
	runId: string
}

class HttpReporter implements Reporter {
	private runIdPromise: Promise<string> | null = null
	private readonly pending: Set<Promise<unknown>> = new Set()
	private warnedUnreachable = false

	constructor(private readonly config: ReporterConfig) {}

	private async ensureRun(): Promise<string> {
		if (!this.runIdPromise) {
			this.runIdPromise = this.startRun()
		}
		return this.runIdPromise
	}

	private async startRun(): Promise<string> {
		const response = await this.fetch('POST', `/api/v1/${this.config.projectId}/runs`, {
			branch: this.config.branch,
			commit: this.config.commit,
			source: this.config.source,
			tier: this.config.tier,
		})
		const runId = response['runId'] as string
		// Synchronous write so the CLI can pick this up even if the test
		// process exits abruptly (process.on('exit') runs sync).
		try {
			mkdirSync(HANDOFF_DIR, { recursive: true })
			const handoff: RunHandoff = {
				endpoint: this.config.endpoint,
				project: this.config.projectId,
				clientId: this.config.clientId,
				clientSecret: this.config.clientSecret,
				runId,
			}
			writeFileSync(handoffPath(), JSON.stringify(handoff), 'utf-8')
		} catch {
			// best-effort
		}
		return runId
	}

	async startScenario(input: ScenarioStart): Promise<string> {
		const runId = await this.ensureRun()
		const response = await this.fetch('POST', `/api/v1/${this.config.projectId}/runs/${runId}/scenarios`, {
			name: input.name,
			hash: input.hash,
			testFile: input.testFile,
			feature: input.feature,
			seeds: input.seeds,
			roles: input.roles,
			tier: input.tier,
		})
		return response['scenarioId'] as string
	}

	async skipScenario(input: ScenarioSkip): Promise<void> {
		const runId = await this.ensureRun()
		// A skipped scenario is created already-finished on the platform — no
		// steps follow, so we don't keep the returned id.
		await this.fetch('POST', `/api/v1/${this.config.projectId}/runs/${runId}/scenarios`, {
			name: input.name,
			hash: input.hash,
			testFile: input.testFile,
			feature: input.feature,
			seeds: input.seeds,
			roles: input.roles,
			tier: input.tier,
			skipped: true,
			reason: input.reason,
		})
	}

	recordStep(event: StepEvent): Promise<void> {
		// Track synchronously so flush() awaits the entire pipeline (including
		// encodeScreenshot's fs.readFile and the upload), not just whatever
		// fragment has run by the time afterAll fires.
		const promise = this.recordStepInternal(event)
		this.track(promise)
		return promise
	}

	private async recordStepInternal(event: StepEvent): Promise<void> {
		const runId = await this.ensureRun()
		const screenshot = event.screenshotPath
			? await this.encodeScreenshot(event.screenshotPath)
			: undefined
		await this.fetch('POST', `/api/v1/${this.config.projectId}/runs/${runId}/scenarios/${event.scenarioId}/steps`, {
			attempt: event.attempt,
			sequence: event.sequence,
			kind: event.kind,
			name: event.name,
			status: event.status,
			durationMs: event.durationMs,
			error: event.error,
			intent: event.intent,
			manual: event.manual,
			reason: event.reason,
			screenshot,
		})
	}

	async finishScenario(input: ScenarioFinish): Promise<void> {
		const runId = await this.ensureRun()
		// Awaited inline so the scenario status is committed before the
		// bun:test afterAll returns.
		await this.fetch('PATCH', `/api/v1/${this.config.projectId}/runs/${runId}/scenarios/${input.scenarioId}`, {
			status: input.status,
			durationMs: input.durationMs,
			attempts: input.attempts,
		})
	}

	async flush(): Promise<void> {
		// Bound the wait: step uploads (a base64 screenshot each) pile up on a
		// slow/contended uplink, and `flush()` is awaited in a scenario's afterAll
		// — an unbounded wait there blows the afterAll budget and fails the
		// scenario over *reporting*, not the test. Best-effort: stop waiting after
		// FLUSH_BUDGET_MS; stragglers settle in the background. Pair with the
		// per-request timeout in `fetch`.
		const budget = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_BUDGET_MS))
		await Promise.race([Promise.allSettled([...this.pending]), budget])
		// finishRun is the CLI's responsibility — see handoff file.
	}

	private track(promise: Promise<unknown>): void {
		this.pending.add(promise)
		promise.finally(() => this.pending.delete(promise))
	}

	private async encodeScreenshot(path: string): Promise<string | undefined> {
		try {
			const buf = await fs.readFile(path)
			return buf.toString('base64')
		} catch {
			return undefined
		}
	}

	private async fetch(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		let response: Response
		try {
			response = await fetch(this.config.endpoint + path, {
				method,
				headers: {
					// Cloudflare Access service-token pair — validated at the edge, never the origin.
					'cf-access-client-id': this.config.clientId,
					'cf-access-client-secret': this.config.clientSecret,
					'content-type': 'application/json',
				},
				body: body == null ? undefined : JSON.stringify(body),
				// Don't let a stalled connection hang past the afterAll budget.
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
		} catch (err) {
			// Network error / blocked request (e.g. a test runner that installs a
			// DOM and routes fetch through a same-origin policy). Callers swallow
			// reporter errors so the test still runs, so this is the one place the
			// failure is visible — make it loud and actionable.
			this.warnUnreachable(`${method} ${path}`, err instanceof Error ? err.message : String(err))
			throw err
		}
		if (!response.ok) {
			const detail = `${response.status} ${await response.text()}`.trim()
			this.warnUnreachable(`${method} ${path}`, detail)
			throw new Error(`opice reporter ${method} ${path} failed: ${detail}`)
		}
		return (await response.json()) as Record<string, unknown>
	}

	/**
	 * A configured reporter that can't reach the platform means the run is
	 * silently NOT recorded — the most confusing failure mode in onboarding
	 * (the test passes, but nothing shows on the dashboard). Surface it once,
	 * with the usual culprits, instead of letting the swallowed throw vanish.
	 */
	private warnUnreachable(call: string, detail: string): void {
		if (this.warnedUnreachable) return
		this.warnedUnreachable = true
		console.error(
			`[opice] reporter could not reach the platform (${call}: ${detail}). `
			+ `This run will NOT be recorded on the dashboard.\n`
			+ `[opice] Common causes:\n`
			+ `[opice]   - the test runner's global setup installs a DOM (happy-dom/jsdom) or mocks\n`
			+ `[opice]     fetch, so the cross-origin POST is blocked (look for "Cross-Origin Request\n`
			+ `[opice]     Blocked" / an OPTIONS … 401). Scope that setup so it skips the e2e dir.\n`
			+ `[opice]   - a missing / expired OPICE_DSN api key (401), or an unreachable endpoint.`,
		)
	}
}

let active: Reporter = new NoopReporter()

export function getReporter(): Reporter {
	return active
}

export function setReporter(reporter: Reporter): void {
	active = reporter
}

export function configureFromEnv(env: NodeJS.ProcessEnv = process.env): Reporter {
	// Individual vars win; OPICE_DSN fills any gaps (see dsn.ts).
	const dsn = parseOpiceDsn(env['OPICE_DSN'])
	const endpoint = env['OPICE_ENDPOINT'] ?? dsn?.endpoint
	const projectId = env['OPICE_PROJECT'] ?? dsn?.project
	const clientId = env['OPICE_CLIENT_ID'] ?? dsn?.clientId
	const clientSecret = env['OPICE_CLIENT_SECRET'] ?? dsn?.clientSecret
	if (!endpoint || !projectId || !clientId || !clientSecret) {
		return new NoopReporter()
	}
	// Reporting is opt-in outside CI. A local `bun test` while authoring would
	// otherwise stream half-finished runs onto the shared dashboard (they never
	// get the CLI's POST /finish, so they'd sit there as "running" forever).
	// CI reports automatically; OPICE_REPORT=always forces it locally, =never
	// silences it everywhere.
	const isCI = !!(env['CI'] || env['GITHUB_ACTIONS'])
	const mode = (env['OPICE_REPORT'] ?? 'auto').toLowerCase()
	const shouldReport = mode === 'never' ? false : mode === 'always' ? true : isCI
	if (!shouldReport) {
		return new NoopReporter()
	}
	const reporter = new HttpReporter({
		endpoint,
		projectId,
		clientId,
		clientSecret,
		branch: env['OPICE_BRANCH'] ?? env['GITHUB_REF_NAME'],
		commit: env['OPICE_COMMIT'] ?? env['GITHUB_SHA'],
		source: isCI ? 'ci' : 'local',
		// Record the selected tier only when one was explicitly requested — a run
		// with no OPICE_TIER ran everything and carries no tier filter.
		tier: env['OPICE_TIER'] ? resolveSelectedTier(env) : undefined,
	})
	setReporter(reporter)
	return reporter
}

// Auto-configure when imported.
configureFromEnv()
