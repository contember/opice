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
	/**
	 * Commit timestamp (ms). Orders the change-tracking index by SOURCE revision
	 * rather than by when a workflow happened to start — otherwise re-running an
	 * old pipeline outranks a newer commit purely by wall clock.
	 */
	commitTime?: number
	commitDepth?: number
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

export interface VideoUpload {
	scenarioId: string
	/** Local path to the saved `.webm` (from the harness context, OPICE_VIDEO). */
	filePath: string
}

export interface FootprintUpload {
	scenarioId: string
	/**
	 * The serialized footprint. The harness already writes the same JSON to disk,
	 * so it hands the string over rather than making this re-serialize a document
	 * that runs to megabytes at the collector's caps.
	 */
	body: string
	/**
	 * Did the walkthrough finish without a failure? Only a complete footprint may
	 * be indexed for change tracking — see the call site in `scenario.ts`.
	 */
	complete: boolean
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
	 * (it doesn't count toward {@link hadFailures}). No-op unless reporting to the
	 * platform.
	 */
	uploadVideo(input: VideoUpload): Promise<void>
	/**
	 * Ship a scenario's footprint (opt-in, OPICE_FOOTPRINT) to the platform.
	 * Best-effort exactly like {@link uploadVideo}: it is evidence, not a result,
	 * so a failure is logged, never counted toward {@link hadFailures}, and never
	 * reds the run. The local JSON artifact is written by the harness regardless,
	 * so nothing is lost when there's no platform.
	 */
	uploadFootprint(input: FootprintUpload): Promise<void>
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
	async uploadVideo(_input: VideoUpload): Promise<void> {}
	async uploadFootprint(_input: FootprintUpload): Promise<void> {}
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
	/** One "not indexed" notice per process — it's the same fact for every scenario. */
	private warnedNotIndexed = false
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
			commitTime: this.config.commitTime,
			commitDepth: this.config.commitDepth,
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

	/**
	 * PUT one per-scenario asset (a walkthrough video, a footprint) as a raw body
	 * — neither fits the JSON-envelope shape {@link fetch} uses for every other
	 * call. Awaited inline by the harness before the scenario finishes: there's at
	 * most one of each per scenario, and a fire-and-forget upload could be cut off
	 * when the test process exits.
	 *
	 * Deliberately NOT retried like a step record: these are bulky and entirely
	 * optional, and a retry storm at teardown would cost more than the data is
	 * worth. Every failure path logs and returns — a dropped asset must never fail
	 * the run, so none of this touches the strict-mode failure count.
	 *
	 * Returns the platform's JSON reply so a caller can act on the parts specific
	 * to its asset, or null if there wasn't one.
	 */
	private async putScenarioAsset(input: {
		scenarioId: string
		/** Path segment + the noun used in log lines. */
		kind: 'video' | 'footprint'
		body: BodyInit
		contentType: string
		timeoutMs: number
		/** Appended to the URL, for the few facts that aren't part of the body. */
		query?: Record<string, string>
	}): Promise<Record<string, unknown> | null> {
		// Resolve the run id first (cheap — memoized once the first scenario
		// started). A rejected run-start is swallowed: no run ⇒ nothing to attach
		// to, but it must never throw out of this best-effort path.
		const runId = await this.ensureRun().catch(() => undefined)
		if (!runId) return null
		const search = input.query ? `?${new URLSearchParams(input.query).toString()}` : ''
		const path = `/api/v1/${this.config.projectId}/runs/${runId}/scenarios/${input.scenarioId}/${input.kind}${search}`
		const call = `PUT ${path}`
		try {
			const response = await fetch(this.config.endpoint + path, {
				method: 'PUT',
				headers: {
					'cf-access-client-id': this.config.clientId,
					'cf-access-client-secret': this.config.clientSecret,
					'content-type': input.contentType,
				},
				body: input.body,
				redirect: 'manual',
				signal: AbortSignal.timeout(input.timeoutMs),
			})
			if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
				console.error(`[opice] ${call} failed: redirected to Cloudflare Access — the ${input.kind} was NOT uploaded (service token rejected at the edge).`)
				return null
			}
			if (!response.ok) {
				console.error(`[opice] ${call} failed: ${response.status} ${(await response.text()).trim()} — the ${input.kind} was NOT uploaded.`)
				return null
			}
			return (await response.json().catch(() => null)) as Record<string, unknown> | null
		} catch (err) {
			console.error(`[opice] ${call} error: ${err instanceof Error ? err.message : String(err)} — the ${input.kind} was NOT uploaded.`)
			return null
		}
	}

	async uploadVideo(input: VideoUpload): Promise<void> {
		let body: Blob
		try {
			// `fs.readFile` returns a Node Buffer, which Blob accepts directly — no
			// intermediate Uint8Array copy (Blob copies the part into its own storage
			// once regardless).
			body = new Blob([await fs.readFile(input.filePath)], { type: 'video/webm' })
		} catch (err) {
			console.error(`[opice] video upload skipped for scenario ${input.scenarioId}: cannot read ${input.filePath} (${err instanceof Error ? err.message : String(err)})`)
			return
		}
		const result = await this.putScenarioAsset({
			scenarioId: input.scenarioId,
			kind: 'video',
			body,
			contentType: 'video/webm',
			timeoutMs: VIDEO_REQUEST_TIMEOUT_MS,
		})
		if (result?.['videoFailed'] === true) {
			console.error(`[opice] video upload failed for scenario ${input.scenarioId} — the platform could not store it (transient storage error).`)
		}
	}

	async uploadFootprint(input: FootprintUpload): Promise<void> {
		const result = await this.putScenarioAsset({
			scenarioId: input.scenarioId,
			kind: 'footprint',
			body: input.body,
			contentType: 'application/json',
			timeoutMs: REQUEST_TIMEOUT_MS,
			query: { complete: String(input.complete) },
		})
		if (!result) return
		if (result['footprintFailed'] === true) {
			console.error(`[opice] footprint upload failed for scenario ${input.scenarioId} — the platform could not store it (transient storage error).`)
		}
		// The footprint was stored, but the platform did NOT fold it into the
		// change-tracking index — it only accepts CI runs of the default branch.
		// Say so once: a team collecting footprints on a feature branch would
		// otherwise watch `--impacted` report an empty index forever with no clue why.
		if (result['indexed'] === false && !this.warnedNotIndexed) {
			this.warnedNotIndexed = true
			console.error(
				'[opice] footprints are being stored but NOT indexed for change tracking — only a CI run of the '
				+ 'default branch (main/master) may write the index, so `opice test --impacted` will not see them.',
			)
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

/**
 * Strict reporting is requested but the reporter is a no-op — it can never fail,
 * so strict mode has nothing to enforce. Warn rather than silently ignoring it:
 * the user asked for "fail if reporting fails" and is instead getting no
 * reporting at all, which strict can't catch.
 */
/**
 * Is this environment variable set to something meaning YES?
 *
 * `CI=false` is a string, and a plain truthiness test reads it as true. That is
 * not a cosmetic bug: `source` is derived from this, and only a `ci` run of the
 * default branch may replace the shared change-tracking index. A developer whose
 * shell exports `CI=false` — a common way to say "I am not CI" — sitting on
 * `main` with reporting credentials would hand everyone else their local working
 * state as the authoritative answer.
 */
export function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false
	const normalized = value.trim().toLowerCase()
	return normalized !== '' && normalized !== 'false' && normalized !== '0' && normalized !== 'no' && normalized !== 'off'
}

function warnStrictNoop(why: string): void {
	console.error(
		`[opice] OPICE_REPORT_STRICT is set but ${why} — strict reporting has no effect `
		+ `(there is nothing to report, so nothing can fail).`,
	)
}

/** Commit timestamp in ms, from `OPICE_COMMIT_TIME` (seconds or ms). */
function commitDepth(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env['OPICE_COMMIT_DEPTH']
	if (raw) {
		const n = Number(raw)
		if (Number.isInteger(n) && n > 0) return n
	}
	return gitCommitDepth()
}

function commitTime(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env['OPICE_COMMIT_TIME'] ?? gitCommitTime()
	if (!raw) return undefined
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return undefined
	// git's `%ct` is seconds; accept either and normalize to ms.
	return n < 1e12 ? Math.round(n * 1000) : Math.round(n)
}

/**
 * The commit's depth on its branch, or undefined when it cannot be trusted.
 *
 * A better revision key than the timestamp: `%ct` has second resolution, so two
 * trunk commits can share one, and committer dates can invert outright between
 * runners with skewed clocks. Depth only ever grows as the trunk advances.
 *
 * Refused on a SHALLOW clone, which is the default for most CI checkouts. There
 * `rev-list --count` answers the depth of the CLONE, not of the commit — a
 * constant 1 for `fetch-depth: 1` — so believing it would rank every run equal
 * and, worse, could rank a newer run below an older one. Undefined simply falls
 * back to the timestamp, which is what happens today.
 */
let cachedDepth: number | undefined | null
function gitCommitDepth(): number | undefined {
	if (cachedDepth === undefined) {
		cachedDepth = null
		if (gitOutput(['rev-parse', '--is-shallow-repository']) === 'false') {
			const count = Number(gitOutput(['rev-list', '--count', 'HEAD']))
			if (Number.isInteger(count) && count > 0) cachedDepth = count
		}
	}
	return cachedDepth ?? undefined
}

/**
 * The branch this CI provider reports, if any.
 *
 * Mirrors the CLI's list, deliberately duplicated: the harness is what a user's
 * repo installs and it cannot import from `@opice/cli`. Keeping the two in step
 * matters because a null branch is not a cosmetic gap — the worker's
 * default-branch gate rejects every footprint from a run it cannot attribute, so
 * on GitLab the index would simply never populate, with nothing saying why.
 *
 * A merge-request variable is deliberately absent: a PR build is not a
 * default-branch build.
 */
export function ciBranch(env: NodeJS.ProcessEnv): string | undefined {
	return usableBranch(
		env['GITHUB_REF_NAME'] // GitHub Actions
		?? env['CI_COMMIT_BRANCH'] // GitLab CI
		?? env['BUILDKITE_BRANCH'] // Buildkite
		?? env['CIRCLE_BRANCH'] // CircleCI
		?? env['BRANCH_NAME'] // Jenkins multibranch
		?? env['DRONE_BRANCH'] // Drone
		?? env['BITBUCKET_BRANCH'] // Bitbucket Pipelines
		?? env['CF_PAGES_BRANCH'], // Cloudflare Pages
	)
}

/**
 * The commit SHA this CI provider reports, if any.
 *
 * Not cosmetic either: the worker groups bun's per-test-file runs by
 * `commit_sha` to build a scenario inventory, so a null SHA collapses a whole
 * suite to whichever single run was newest — and `unindexed` then reports zero
 * while sibling files go uninventoried.
 */
export function ciCommit(env: NodeJS.ProcessEnv): string | undefined {
	const value = env['GITHUB_SHA'] // GitHub Actions
		?? env['CI_COMMIT_SHA'] // GitLab CI
		?? env['BUILDKITE_COMMIT'] // Buildkite
		?? env['CIRCLE_SHA1'] // CircleCI
		?? env['GIT_COMMIT'] // Jenkins
		?? env['DRONE_COMMIT_SHA'] // Drone
		?? env['BITBUCKET_COMMIT'] // Bitbucket Pipelines
		?? env['CF_PAGES_COMMIT_SHA'] // Cloudflare Pages
	return value?.trim() || undefined
}

/**
 * The checked-out branch, straight from git. Resolved once, best-effort — the
 * last resort when neither the CLI nor a CI provider named one.
 */
let cachedBranch: string | undefined | null
function gitBranch(): string | undefined {
	if (cachedBranch === undefined) {
		cachedBranch = usableBranch(gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? null
	}
	return cachedBranch ?? undefined
}

/** A branch name, or undefined for the empty string and git's detached-HEAD placeholder. */
export function usableBranch(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed && trimmed !== 'HEAD' ? trimmed : undefined
}

/**
 * The HEAD commit's timestamp, straight from git. Resolved once, best-effort.
 *
 * `opice test` injects OPICE_COMMIT_TIME, but a plain `bun test` in CI is a
 * supported path and sets nothing — and the platform refuses to index a
 * footprint it cannot order by revision, because ordering by wall clock lets a
 * re-run of an old workflow overwrite a newer commit's edges. Asking git costs
 * one process at startup and keeps that path working; where git isn't there, the
 * answer is simply undefined and the footprint goes unindexed rather than wrong.
 */
let cachedCommitTime: string | undefined | null
function gitCommitTime(): string | undefined {
	if (cachedCommitTime === undefined) {
		cachedCommitTime = null
		cachedCommitTime = gitOutput(['show', '-s', '--format=%ct', 'HEAD']) ?? null
	}
	return cachedCommitTime ?? undefined
}

/**
 * Run git and return its trimmed output, or undefined for any failure. No git,
 * no checkout, no HEAD — all fine, all simply mean "cannot answer".
 */
function gitOutput(args: string[]): string | undefined {
	try {
		// Required lazily: this module is imported under plain Node by the authoring
		// daemon, and there is no reason to pay for it until asked.
		const { execFileSync } = require('node:child_process') as typeof import('node:child_process')
		return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
	} catch {
		return undefined
	}
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
	const isCI = isTruthyEnv(env['CI']) || isTruthyEnv(env['GITHUB_ACTIONS'])
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
		branch: env['OPICE_BRANCH'] ?? ciBranch(env) ?? gitBranch(),
		commit: env['OPICE_COMMIT'] ?? ciCommit(env) ?? gitOutput(['rev-parse', 'HEAD']),
		...(commitTime(env) !== undefined ? { commitTime: commitTime(env) } : {}),
		...(commitDepth(env) !== undefined ? { commitDepth: commitDepth(env) } : {}),
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
