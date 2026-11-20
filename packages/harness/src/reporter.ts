/**
 * Reporter — streams scenario/step/screenshot events to the opice platform.
 *
 * Steps are fire-and-forget (tracked in a pending queue so flush awaits
 * them). Scenario create + finish are awaited inline so the platform sees
 * the right status when the test process exits.
 *
 * The CLI handles end-of-run finalization: the reporter writes a
 * handoff file under $TMPDIR with the runId and credentials, the
 * `opice test` wrapper picks it up after `bun test` exits and calls
 * `reports.finishRun` so the dashboard sees the run as completed.
 *
 * When env vars aren't configured, the reporter falls back to a no-op so
 * harness behavior matches the bindx prototype.
 */

import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseOpiceDsn } from './dsn.js'
import { isTruthy } from './env.js'
import { FileReporter } from './file-reporter.js'
import { resolveSelectedTier } from './tier.js'

/** Per-request cap, so a hung connection can't stall a scenario's afterAll. */
const REQUEST_TIMEOUT_MS = 10_000
/**
 * Longer cap for a video PUT — a walkthrough webm is megabytes, not the few KB of
 * a step screenshot, so it needs more headroom than {@link REQUEST_TIMEOUT_MS}.
 * Still bounded so a stalled upload can't hang the scenario's afterAll forever.
 */
const VIDEO_REQUEST_TIMEOUT_MS = 30_000
/** The platform's machine mount: each report is `POST <endpoint>/machine/reports.<name>`. */
export const MACHINE_PREFIX = '/machine'

/** One file field of a multipart report (a step's screenshot, a scenario's video). */
interface UploadFile {
	field: string
	name: string
	body: Blob
}

/** The platform's multipart form: a nameless `input` part holding the JSON fields, then the file part. */
function multipart(input: Record<string, unknown>, file: UploadFile): FormData {
	const form = new FormData()
	form.append('input', JSON.stringify(input))
	form.append(file.field, file.body, file.name)
	return form
}
/** Total cap on `flush()` waiting for pending step uploads (afterAll-bounded). */
const FLUSH_BUDGET_MS = 15_000
/**
 * Backoff between retries of a transient reporter failure (network error, 5xx,
 * 429). Length = number of retries. A connection-level failure returns in
 * milliseconds, so these waits ARE the retry window: it has to outlast a brief
 * disturbance on the path to the platform while still fitting inside
 * {@link FLUSH_BUDGET_MS}.
 */
const REPORT_BACKOFF_MS = [300, 1000, 3000]

export interface ReporterConfig {
	endpoint: string
	projectId: string
	/** The platform service key (`px_…`, the OPICE_DSN userinfo / OPICE_KEY), sent as a bearer token. */
	key: string
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
 * a config/auth failure, or a run nothing was recorded of, fails the run (the
 * harness throws from a scenario's `afterAll`; the CLI escalates a failed
 * `POST /finish` to a non-zero exit). A single lost report does not: see
 * {@link Reporter.reportingFailed}.
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

export interface VideoUpload {
	scenarioId: string
	/** Local path to the saved `.webm` (from the harness context, OPICE_VIDEO). */
	filePath: string
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
	/**
	 * Upload a scenario's walkthrough video (opt-in, OPICE_VIDEO) to the platform.
	 * Best-effort like a screenshot — a failure is logged but never fails the run
	 * (it doesn't count toward {@link Reporter.reportingFailed}). No-op unless
	 * reporting to the platform.
	 */
	uploadVideo(input: VideoUpload): Promise<void>
	finishScenario(input: ScenarioFinish): Promise<void>
	flush(): Promise<void>
	/**
	 * True if reporting broke in a way strict reporting must fail the run on: a
	 * config/auth failure no retry can fix, or transient failures with not one
	 * successful report. An isolated lost report is neither — it costs a step on
	 * the dashboard, not the build. Always false for the no-op reporter.
	 */
	reportingFailed(): boolean
}

class NoopReporter implements Reporter {
	async startScenario(input: ScenarioStart): Promise<string> {
		return `noop-${input.name}-${Date.now()}`
	}
	async skipScenario(_input: ScenarioSkip): Promise<void> {}
	async recordStep(_event: StepEvent): Promise<void> {}
	async uploadVideo(_input: VideoUpload): Promise<void> {}
	async finishScenario(_input: ScenarioFinish): Promise<void> {}
	async flush(): Promise<void> {}
	reportingFailed(): boolean {
		return false
	}
}

export const HANDOFF_DIR = path.join(tmpdir(), 'opice-handoffs')

function handoffPath(pid = process.pid): string {
	return path.join(HANDOFF_DIR, `${pid}.json`)
}

export interface RunHandoff {
	endpoint: string
	/** Project id, for the CLI's log line. */
	project: string
	/** The service key the CLI calls `reports.finishRun` with. */
	key: string
	runId: string
}

class HttpReporter implements Reporter {
	private runIdPromise: Promise<string> | null = null
	private readonly pending: Set<Promise<unknown>> = new Set()
	private warnedUnreachable = false
	/** Reports that reached the platform. Zero means the dashboard has nothing of this run. */
	private successes = 0
	/** Failed reports (network error or non-2xx), for the log summary. */
	private failures = 0
	/** Failures no retry can fix (auth, config, a non-JSON 200). */
	private fatalFailures = 0

	constructor(private readonly config: ReporterConfig) {}

	reportingFailed(): boolean {
		return this.fatalFailures > 0 || (this.failures > 0 && this.successes === 0)
	}

	private async ensureRun(): Promise<string> {
		if (!this.runIdPromise) {
			this.runIdPromise = this.startRun()
		}
		return this.runIdPromise
	}

	private async startRun(): Promise<string> {
		const response = await this.fetch('reports.startRun', {
			projectId: this.config.projectId,
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
				key: this.config.key,
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
		const response = await this.fetch('reports.startScenario', {
			runId,
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
		await this.fetch('reports.skipScenario', {
			runId,
			name: input.name,
			hash: input.hash,
			testFile: input.testFile,
			feature: input.feature,
			seeds: input.seeds,
			roles: input.roles,
			tier: input.tier,
			reason: input.reason,
		})
	}

	recordStep(event: StepEvent): Promise<void> {
		// Track synchronously so flush() awaits the entire pipeline (including
		// readFile and the upload), not just whatever
		// fragment has run by the time afterAll fires.
		//
		// Fire-and-forget by contract: the caller discards this promise, so a lost
		// step must resolve — a rejection reaches bun as "Unhandled error between
		// tests" and reds the file. noteFailure already logged and counted it.
		const promise = this.recordStepInternal(event).catch(() => {})
		this.track(promise)
		return promise
	}

	private async recordStepInternal(event: StepEvent): Promise<void> {
		const runId = await this.ensureRun()
		const screenshot = event.screenshotPath
			? await this.readFile(event.screenshotPath, 'image/png')
			: undefined
		const step = {
			runId,
			scenarioId: event.scenarioId,
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
		}
		if (!screenshot) {
			await this.fetch('reports.step', step)
			return
		}
		try {
			await this.fetch('reports.step', step, { field: 'screenshot', name: 'screenshot.png', body: screenshot }, { quiet: true })
		} catch (err) {
			// The step matters more than its picture: record it without the file, marked, so the gap on the dashboard
			// isn't a mystery. Only a failure of this second call counts as a lost report.
			console.error(`[opice] screenshot upload failed for step "${event.name}" (${err instanceof Error ? err.message : String(err)}) — recording the step without it.`)
			await this.fetch('reports.step', { ...step, screenshotFailed: true })
		}
	}

	/**
	 * Upload a scenario's walkthrough video as a multipart file field. Awaited inline by the harness before the
	 * scenario finishes — there's at most one per scenario, and a fire-and-forget upload could be cut off when the test
	 * process exits. Best-effort: any failure (missing file, storage hiccup, auth) is logged and swallowed — a dropped
	 * video must never fail the run, so it does NOT touch the strict-mode failure count.
	 */
	async uploadVideo(input: VideoUpload): Promise<void> {
		// A rejected run-start is swallowed: no run ⇒ nothing to attach the video to.
		const runId = await this.ensureRun().catch(() => undefined)
		if (!runId) return
		const video = await this.readFile(input.filePath, 'video/webm')
		if (!video) {
			console.error(`[opice] video upload skipped for scenario ${input.scenarioId}: cannot read ${input.filePath}`)
			return
		}
		const result = await this.attempt(
			'reports.video',
			{ runId, scenarioId: input.scenarioId },
			{ field: 'video', name: 'video.webm', body: video },
			VIDEO_REQUEST_TIMEOUT_MS,
		)
		if (!('data' in result)) {
			console.error(`[opice] ${MACHINE_PREFIX}/reports.video failed: ${result.detail} — the video was NOT uploaded.`)
		}
	}

	async finishScenario(input: ScenarioFinish): Promise<void> {
		const runId = await this.ensureRun()
		// Awaited inline so the scenario status is committed before the
		// bun:test afterAll returns.
		await this.fetch('reports.finishScenario', {
			runId,
			scenarioId: input.scenarioId,
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

	private async readFile(filePath: string, type: string): Promise<Blob | undefined> {
		try {
			// A Node Buffer goes into the Blob directly — no intermediate copy.
			return new Blob([await fs.readFile(filePath)], { type })
		} catch {
			return undefined
		}
	}

	private async fetch(
		procedure: string,
		input: Record<string, unknown>,
		file?: UploadFile,
		options: { quiet?: boolean } = {},
	): Promise<Record<string, unknown>> {
		// Retry only TRANSIENT failures (network error, 5xx, 429) with a short
		// backoff — a momentary blip or a cold start shouldn't read as a lost
		// report. NON-transient failures (a 3xx, a 4xx, a body that isn't the
		// platform's answer) are config/auth problems a retry can't fix, so they
		// surface immediately — which is exactly what strict mode is meant to make
		// loud. `noteFailure` only fires once retries are spent, so a blip that
		// clears on retry isn't recorded as a failure at all.
		for (let attempt = 0; ; attempt++) {
			const result = await this.attempt(procedure, input, file, REQUEST_TIMEOUT_MS)
			if ('data' in result) {
				this.successes++
				return result.data
			}
			const delay = REPORT_BACKOFF_MS[attempt]
			if (result.retryable && delay !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, delay))
				continue
			}
			if (!options.quiet) this.noteFailure(`${MACHINE_PREFIX}/${procedure}`, result.detail, !result.retryable)
			throw result.error
		}
	}

	/**
	 * One call of a machine procedure. Classifies the outcome — `data` on success,
	 * otherwise `retryable` tells {@link fetch} whether a retry could help — so the
	 * retry/throw decision lives in one place.
	 */
	private async attempt(
		procedure: string,
		input: Record<string, unknown>,
		file: UploadFile | undefined,
		timeoutMs: number,
	): Promise<{ data: Record<string, unknown> } | { retryable: boolean; detail: string; error: Error }> {
		const call = `${MACHINE_PREFIX}/${procedure}`
		const fail = (retryable: boolean, detail: string) => ({ retryable, detail, error: new Error(`opice reporter ${call} failed: ${detail}`) })
		const authorization = `Bearer ${this.config.key}`
		let response: Response
		try {
			response = await fetch(this.config.endpoint + call, {
				method: 'POST',
				// A multipart body sets its own content type, with the boundary.
				headers: file ? { authorization } : { authorization, 'content-type': 'application/json' },
				body: file ? multipart(input, file) : JSON.stringify(input),
				// 'manual': a sign-in redirect must read as an auth failure, not be chased into an HTML page.
				redirect: 'manual',
				// Don't let a stalled connection hang past the afterAll budget.
				signal: AbortSignal.timeout(timeoutMs),
			})
		} catch (err) {
			// Network error / blocked request (e.g. a test runner that installs a
			// DOM and routes fetch through a same-origin policy) — could be a transient
			// blip, so it's retryable.
			return fail(true, err instanceof Error ? err.message : String(err))
		}
		if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
			const location = response.headers.get('location') ?? ''
			return fail(false, `unexpected redirect (${response.status}${location ? ` → ${location}` : ''}) — the service key was not accepted`)
		}
		if (response.status === 401 || response.status === 403) {
			return fail(false, `${response.status} ${(await response.text()).trim()} — the OPICE_DSN service key is unknown, revoked, or holds no report.write in project ${this.config.projectId}`)
		}
		if (!response.ok) {
			// 5xx and 429 are the platform asking us to back off and retry; other 4xx
			// mean the request itself is wrong (validation) — a retry won't change that.
			return fail(response.status >= 500 || response.status === 429, `${response.status} ${(await response.text()).trim()}`)
		}
		// Parse defensively: a 200 that isn't the platform's `{ result }` (a login or
		// proxy page) must count as a failure, not a swallowed throw. Not transient.
		const body: unknown = await response.json().catch(() => undefined)
		const result = body !== null && typeof body === 'object' && 'result' in body ? body.result : undefined
		if (result === null || typeof result !== 'object') {
			const ct = response.headers.get('content-type') ?? 'unknown'
			return fail(false, `${response.status} but the body wasn't the platform's answer (content-type: ${ct})`)
		}
		return { data: { ...result } }
	}

	/**
	 * Record a reporting failure and surface it. Callers swallow reporter errors
	 * so the test still runs (reporting is best-effort), which makes this the one
	 * place a failure is visible — so every failure is logged to stderr (a
	 * configured reporter that can't reach the platform means the run is silently
	 * NOT recorded, the most confusing failure mode in onboarding: the test
	 * passes but nothing shows on the dashboard). The first failure prints the
	 * full hint with the usual culprits; the rest a concise one-liner so a
	 * recurring failure is visible without flooding the log. Feeds
	 * {@link HttpReporter.reportingFailed}, which strict mode fails the run on.
	 */
	private noteFailure(call: string, detail: string, fatal: boolean): void {
		this.failures++
		if (fatal) this.fatalFailures++
		if (this.warnedUnreachable) {
			console.error(`[opice] reporter error (${call}): ${detail} — this report was NOT recorded.`)
			return
		}
		this.warnedUnreachable = true
		console.error(
			`[opice] reporter could not reach the platform (${call}: ${detail}). `
			+ (fatal
				? `Nothing from this run will reach the dashboard.\n`
				: `This report is lost (${REPORT_BACKOFF_MS.length + 1} attempts spent).\n`)
			+ `[opice] ${this.maskedConfig()}\n`
			+ `[opice] Common causes:\n`
			+ `[opice]   - the test runner's global setup installs a DOM (happy-dom/jsdom) or mocks\n`
			+ `[opice]     fetch, so the cross-origin POST is blocked (look for "Cross-Origin Request\n`
			+ `[opice]     Blocked" / an OPTIONS … 401). Scope that setup so it skips the e2e dir.\n`
			+ `[opice]   - the OPICE_DSN service key is unknown or revoked, or holds no report.write\n`
			+ `[opice]     in this project (a 401/403). Keys come from the platform console.\n`
			+ `[opice]   - an unreachable endpoint.\n`
			+ `[opice] (OPICE_REPORT_STRICT / opice test --fail-on-report-error fails the run on a config/auth\n`
			+ `[opice]  failure, or on a run the dashboard never received anything of.)`,
		)
	}

	/**
	 * A masked one-line summary of the resolved reporter config, printed on the
	 * first failure so you can tell *which* DSN reached the harness without leaking
	 * it. endpoint + project are shown whole (not secret); the key only by its
	 * prefix and length — never its secret bytes (CI log hygiene; GH only masks the
	 * exact secret string, not a prefix).
	 */
	private maskedConfig(): string {
		const key = this.config.key
		const shape = key.startsWith('px_') ? `px_… (len ${key.length})` : `not a px_ key (len ${key.length})`
		return `resolved config (masked): endpoint=${this.config.endpoint} project=${this.config.projectId} key=${shape}`
	}
}

let active: Reporter = new NoopReporter()

export function getReporter(): Reporter {
	return active
}

export function setReporter(reporter: Reporter): void {
	active = reporter
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
		// OPICE_REPORT_PARTS_DIR (set by `opice test`, fresh per run) lets the
		// per-file `bun test` processes aggregate into one report instead of the
		// last file clobbering the rest. Absent under bare `bun test`.
		const reporter = new FileReporter(reportFile, env['OPICE_REPORT_PARTS_DIR'])
		setReporter(reporter)
		return reporter
	}
	// Individual vars win; OPICE_DSN fills any gaps (see dsn.ts).
	const dsn = parseOpiceDsn(env['OPICE_DSN'])
	const endpoint = env['OPICE_ENDPOINT'] ?? dsn?.endpoint
	const projectId = env['OPICE_PROJECT'] ?? dsn?.project
	const key = env['OPICE_KEY'] ?? dsn?.key
	if (env['OPICE_DSN'] && !dsn) {
		console.error('[opice] OPICE_DSN is not a DSN of this platform (https://<px_ key>@<host>/<project id>); a DSN with a password is the old platform\'s.')
	}
	if (!endpoint || !projectId || !key) {
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
		key,
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
