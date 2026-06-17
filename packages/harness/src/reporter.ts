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
import { FileReporter } from './file-reporter.js'
import { resolveSelectedTier } from './tier.js'

/** Per-request cap, so a hung connection can't stall a scenario's afterAll. */
const REQUEST_TIMEOUT_MS = 10_000
/** Total cap on `flush()` waiting for pending step uploads (afterAll-bounded). */
const FLUSH_BUDGET_MS = 15_000
/**
 * Backoff between retries of a transient reporter failure (network error, 5xx,
 * 429). Length = number of retries; kept short so retries stay inside the
 * afterAll / flush budgets above.
 */
const REPORT_BACKOFF_MS = [300, 800]

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

/**
 * Strict reporting policy, resolved once from the env in {@link configureFromEnv}.
 *
 * Reporting is best-effort by design — a flaky uplink or a dashboard outage must
 * never redden an otherwise-green test run. But that decoupling hides a real
 * failure mode: a misconfigured token or an unreachable endpoint means the run
 * is silently NOT recorded, while CI stays green. Strict mode (opt in via
 * `OPICE_REPORT_STRICT` / `opice test --fail-on-report-error`) makes that loud —
 * any reporting failure fails the run (the harness throws from a scenario's
 * `afterAll`; the CLI escalates a failed `POST /finish` to a non-zero exit).
 */
let strictReporting = false

/** Whether strict reporting is active (see {@link strictReporting}). */
export function isStrictReporting(): boolean {
	return strictReporting
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
	/**
	 * True if any report to the platform failed (network error or non-2xx). Used
	 * by the harness to fail the run under strict reporting — see
	 * {@link isStrictReporting}. Always false for the no-op reporter.
	 */
	hadFailures(): boolean
}

class NoopReporter implements Reporter {
	async startScenario(input: ScenarioStart): Promise<string> {
		return `noop-${input.name}-${Date.now()}`
	}
	async skipScenario(_input: ScenarioSkip): Promise<void> {}
	async recordStep(_event: StepEvent): Promise<void> {}
	async finishScenario(_input: ScenarioFinish): Promise<void> {}
	async flush(): Promise<void> {}
	hadFailures(): boolean {
		return false
	}
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
	/** Count of failed reports (network error or non-2xx). Drives strict mode. */
	private failures = 0

	constructor(private readonly config: ReporterConfig) {}

	hadFailures(): boolean {
		return this.failures > 0
	}

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
		const result = await this.fetch('POST', `/api/v1/${this.config.projectId}/runs/${runId}/scenarios/${event.scenarioId}/steps`, {
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
		// The step itself was recorded; only its screenshot upload to R2 failed
		// (a transient R2 error the platform swallowed). Surface it in the run log
		// so the gap on the dashboard isn't a mystery — but it's NOT a reporting
		// failure (the step is there), so it doesn't touch the strict-mode count.
		if (screenshot && result['screenshotFailed'] === true) {
			console.error(`[opice] screenshot upload failed for step "${event.name}" — the step was recorded without it (transient storage error).`)
		}
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
		const call = `${method} ${path}`
		// Retry only TRANSIENT failures (network error, 5xx, 429) with a short
		// backoff — a momentary blip or a worker cold-start shouldn't read as a lost
		// report. NON-transient failures (a 3xx to Access, a 4xx, a non-JSON 200)
		// are config/auth problems a retry can't fix, so they surface immediately —
		// which is exactly what strict mode is meant to make loud. `noteFailure` (and
		// the failure count strict mode reads) only fires once retries are spent, so
		// a blip that clears on retry isn't recorded as a failure at all.
		for (let attempt = 0; ; attempt++) {
			const result = await this.attempt(method, path, body)
			if ('data' in result) return result.data
			const delay = REPORT_BACKOFF_MS[attempt]
			if (result.retryable && delay !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, delay))
				continue
			}
			this.noteFailure(call, result.detail)
			throw result.error
		}
	}

	/**
	 * One round-trip to the platform. Classifies the outcome — `data` on success,
	 * otherwise `retryable` tells {@link fetch} whether a retry could help — so the
	 * retry/throw decision lives in one place.
	 */
	private async attempt(
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ data: Record<string, unknown> } | { retryable: boolean; detail: string; error: Error }> {
		const call = `${method} ${path}`
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
				// 'manual': when Access rejects the service token it answers a 302 to its
				// login page (an HTML 200/404 after the hop), NOT a JSON 401. The default
				// 'follow' would chase that redirect and we'd then choke on .json() of an
				// HTML body — a failure that slips past the !ok check below and goes
				// silent. Keeping the 3xx lets us name it as an auth rejection instead.
				redirect: 'manual',
				// Don't let a stalled connection hang past the afterAll budget.
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			})
		} catch (err) {
			// Network error / blocked request (e.g. a test runner that installs a
			// DOM and routes fetch through a same-origin policy) — could be a transient
			// blip, so it's retryable.
			const error = err instanceof Error ? err : new Error(String(err))
			return { retryable: true, detail: error.message, error }
		}
		// A redirect (3xx, or an opaque redirect when the runtime hides the status)
		// to Cloudflare Access means the service token was rejected at the edge —
		// the request never reached the API. This is THE prod failure mode: the
		// DSN's token isn't authorized by the `/api/v1` Access policy. Never transient.
		if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
			const location = response.headers.get('location') ?? ''
			const detail = /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location)
				? `redirected to Cloudflare Access login (${response.status}) — the OPICE_DSN service token was rejected at the edge. `
					+ `Authorize it on the prod /api/v1 Access (Service Auth) policy, or check the token in OPICE_DSN.`
				: `unexpected redirect (${response.status}${location ? ` → ${location}` : ''})`
			return { retryable: false, detail, error: new Error(`opice reporter ${call} failed: ${detail}`) }
		}
		if (!response.ok) {
			const detail = `${response.status} ${await response.text()}`.trim()
			// 5xx and 429 are the platform asking us to back off and retry (e.g. a
			// transient R2 internal error bubbling up as a 500); other 4xx mean the
			// request itself is wrong (auth, validation) — a retry won't change that.
			const retryable = response.status >= 500 || response.status === 429
			return { retryable, detail, error: new Error(`opice reporter ${call} failed: ${detail}`) }
		}
		// Parse defensively: a 200 that isn't JSON (an auth/login HTML page slipped
		// through, a proxy error page) must count as a failure, not a swallowed
		// throw — otherwise strict mode never sees it. Not transient.
		try {
			return { data: (await response.json()) as Record<string, unknown> }
		} catch {
			const ct = response.headers.get('content-type') ?? 'unknown'
			const detail = `${response.status} but body wasn't JSON (content-type: ${ct}) — `
				+ `likely an auth/login or proxy page, not the opice API`
			return { retryable: false, detail, error: new Error(`opice reporter ${call} failed: ${detail}`) }
		}
	}

	/**
	 * Record a reporting failure and surface it. Callers swallow reporter errors
	 * so the test still runs (reporting is best-effort), which makes this the one
	 * place a failure is visible — so every failure is logged to stderr (a
	 * configured reporter that can't reach the platform means the run is silently
	 * NOT recorded, the most confusing failure mode in onboarding: the test
	 * passes but nothing shows on the dashboard). The first failure prints the
	 * full hint with the usual culprits; the rest a concise one-liner so a
	 * recurring failure is visible without flooding the log. Counts toward
	 * {@link hadFailures}, which strict mode fails the run on.
	 */
	private noteFailure(call: string, detail: string): void {
		this.failures++
		if (this.warnedUnreachable) {
			console.error(`[opice] reporter error (${call}): ${detail} — this report was NOT recorded.`)
			return
		}
		this.warnedUnreachable = true
		console.error(
			`[opice] reporter could not reach the platform (${call}: ${detail}). `
			+ `This run will NOT be recorded on the dashboard.\n`
			+ `[opice] ${this.maskedConfig()}\n`
			+ `[opice] Common causes:\n`
			+ `[opice]   - the test runner's global setup installs a DOM (happy-dom/jsdom) or mocks\n`
			+ `[opice]     fetch, so the cross-origin POST is blocked (look for "Cross-Origin Request\n`
			+ `[opice]     Blocked" / an OPTIONS … 401). Scope that setup so it skips the e2e dir.\n`
			+ `[opice]   - the OPICE_DSN service token isn't authorized by the platform's /api/v1\n`
			+ `[opice]     Cloudflare Access policy (a 302 to the Access login), or it's wrong/expired.\n`
			+ `[opice]   - an unreachable endpoint.\n`
			+ `[opice] (set OPICE_REPORT_STRICT=1 / opice test --fail-on-report-error to fail the run on this.)`,
		)
	}

	/**
	 * A masked one-line summary of the resolved reporter config, printed on the
	 * first failure so you can tell *which* DSN reached the harness without leaking
	 * it. endpoint + project are shown whole (not secret); the clientId keeps its
	 * head+tail so a real Cloudflare Access service token's `.access` suffix is
	 * visible (and a wrong shape stands out); the clientSecret is reduced to its
	 * length + char-class — never its bytes (CI log hygiene; GH only masks the
	 * exact secret string, not a prefix).
	 */
	private maskedConfig(): string {
		const id = this.config.clientId
		const secret = this.config.clientSecret
		const maskedId = id.length <= 14 ? `${id.slice(0, 1)}…(len ${id.length})` : `${id.slice(0, 6)}…${id.slice(-8)} (len ${id.length})`
		const secretShape = !secret ? '(empty!)' : `len ${secret.length}, ${/^[0-9a-f]+$/i.test(secret) ? 'hex' : 'non-hex'}`
		return `resolved config (masked): endpoint=${this.config.endpoint} project=${this.config.projectId} `
			+ `clientId=${maskedId} clientSecret=(${secretShape})`
	}
}

let active: Reporter = new NoopReporter()

export function getReporter(): Reporter {
	return active
}

export function setReporter(reporter: Reporter): void {
	active = reporter
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false
	const v = value.toLowerCase()
	return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * Strict reporting is requested but the reporter is a no-op — it can never fail,
 * so strict mode has nothing to enforce. Warn rather than silently ignoring it:
 * the user asked for "fail if reporting fails" and is instead getting no
 * reporting at all, which strict can't catch.
 */
function warnStrictNoop(why: string): void {
	console.error(
		`[opice] OPICE_REPORT_STRICT is set but ${why} — strict reporting has no effect `
		+ `(there is nothing to report, so nothing can fail).`,
	)
}

export function configureFromEnv(env: NodeJS.ProcessEnv = process.env): Reporter {
	// Strict reporting: fail the run if any report to the platform fails. Opt-in
	// (default best-effort is locked design), resolved once here for the whole
	// process. The CLI's `--fail-on-report-error` sets OPICE_REPORT_STRICT in the
	// child env, so a bare `bun test` honours it too.
	strictReporting = isTruthy(env['OPICE_REPORT_STRICT'])
	// Local HTML report (enhanced local DX): OPICE_REPORT_FILE selects the file
	// reporter, which writes a self-contained report.html and needs NO platform
	// credentials — the zero-config "dashboard, locally" path. `opice test
	// --report <file>` sets the var for you. Takes precedence over the platform
	// reporter so a local run never needs a DSN to get a rich per-step view.
	const reportFile = env['OPICE_REPORT_FILE']
	if (reportFile) {
		const reporter = new FileReporter(reportFile)
		setReporter(reporter)
		return reporter
	}
	// Individual vars win; OPICE_DSN fills any gaps (see dsn.ts).
	const dsn = parseOpiceDsn(env['OPICE_DSN'])
	const endpoint = env['OPICE_ENDPOINT'] ?? dsn?.endpoint
	const projectId = env['OPICE_PROJECT'] ?? dsn?.project
	const clientId = env['OPICE_CLIENT_ID'] ?? dsn?.clientId
	const clientSecret = env['OPICE_CLIENT_SECRET'] ?? dsn?.clientSecret
	if (!endpoint || !projectId || !clientId || !clientSecret) {
		if (strictReporting) warnStrictNoop('reporter credentials are not configured (no OPICE_DSN / OPICE_* vars)')
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
		if (strictReporting) warnStrictNoop(`reporting is disabled here (OPICE_REPORT=${mode}, CI=${isCI})`)
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
