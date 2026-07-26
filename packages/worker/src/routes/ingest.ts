import { withVideoUrl } from '../asset-url'
import { isDefaultBranch } from '../db'
import { indexableKinds, matchImpact, normalizeFootprint, scenarioKeyOf, summarize, toEdges, type ScenarioFootprint } from '../footprint'
import { badRequest, json, notFound, readJson, serveR2Asset, unauthorized } from '../http'
import { machineCanReadReports, machineCanWriteReports, resolveMachine } from '../principal'
import type { Services } from '../services'
import type { Project, Run, Scenario, ScenarioStatus, StepKind, StepStatus } from '../types'

// Steps accept the tolerated fixme markers + 'pending' (a phase-1 stub); scenario
// finish does not (a scenario is only ever passed/failed — fixme/pending surface
// as derived warning/incomplete).
const ACCEPTED_STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'fixme', 'fixmepass', 'pending']
const ACCEPTED_STEP_KINDS: readonly StepKind[] = ['step', 'invariant']
const ACCEPTED_SCENARIO_STATUSES: readonly ScenarioStatus[] = ['passed', 'failed']

/**
 * The machine API (`/api/v1/<slug>/...`) — BEHIND Cloudflare Access (an "Any Access Service Token"
 * policy), authenticated by a propustka SERVICE-TOKEN principal. The Access edge validates the
 * reporter's / agent's client-id/secret pair and injects the JWT; the Worker resolves the service
 * principal and checks `report.write` (ingest — the OPICE_DSN, POST/PATCH) or `report.read` (the
 * read DSN / `opice failures`, GET) on the project named in the URL. The slug comes from the path,
 * never the token — a token scoped to one project can't touch another's runs by id.
 */
export async function handleApi(request: Request, services: Services, segments: string[]): Promise<Response> {
	const slug = segments[0]
	const path = segments.slice(1)
	if (!slug) {
		return notFound()
	}
	const auth = await resolveMachine(request, services)
	if (!auth.ok) {
		return unauthorized()
	}
	const project = await services.db.getProjectBySlug(slug)
	if (!project) {
		return unauthorized()
	}

	// Impact is a READ that needs a request body: `opice test --impacted` sends the
	// changed-path list from a diff, which is far too long for a query string. So
	// it's a POST that doesn't follow the method split below, and it accepts
	// EITHER report permission. Read is the obvious one. Write is allowed because
	// the ingest DSN is what a CI job running `--impacted` already holds, and the
	// answer — scenario names and their test files — is precisely what that token
	// reports to us in the first place. Requiring a second credential to learn
	// nothing new would buy no security and cost every project a secret.
	if (request.method === 'POST' && path[0] === 'impact' && path.length === 1) {
		if (!machineCanReadReports(auth, slug) && !machineCanWriteReports(auth, slug)) {
			return unauthorized()
		}
		return impact(request, services, project)
	}

	if (request.method === 'GET') {
		if (!machineCanReadReports(auth, slug)) {
			return unauthorized()
		}
		return handleRead(services, project, path)
	}
	if (!machineCanWriteReports(auth, slug)) {
		return unauthorized()
	}
	return handleWrite(request, services, project, path)
}

/** Ingest writes — POST runs / scenarios / steps / finish, PATCH a scenario. */
async function handleWrite(request: Request, services: Services, project: Project, path: string[]): Promise<Response> {
	if (request.method === 'POST' && path.length === 1 && path[0] === 'runs') {
		return createRun(request, services, project)
	}

	if (path[0] === 'runs' && path[1]) {
		const runId = path[1]
		const run = await services.db.getRun(runId)
		if (!run || run.projectId !== project.id) {
			return notFound('run not found')
		}

		// Every scenario/step write is a heartbeat — keeps the reaper from
		// treating an in-flight run as abandoned. (finish sets finished_at
		// itself, so it needs no touch.)
		if (path[2] === 'scenarios') {
			await services.db.touchRun(runId)
		}

		if (request.method === 'POST' && path[2] === 'scenarios' && path.length === 3) {
			return createScenario(request, services, runId)
		}
		if (request.method === 'PATCH' && path[2] === 'scenarios' && path[3] && path.length === 4) {
			return finishScenario(request, services, path[3])
		}
		if (request.method === 'POST' && path[2] === 'scenarios' && path[3] && path[4] === 'steps' && path.length === 5) {
			return createStep(request, services, project, runId, path[3])
		}
		if (request.method === 'PUT' && path[2] === 'scenarios' && path[3] && path[4] === 'video' && path.length === 5) {
			return uploadVideo(request, services, project, runId, path[3])
		}
		if (request.method === 'PUT' && path[2] === 'scenarios' && path[3] && path[4] === 'footprint' && path.length === 5) {
			return uploadFootprint(request, services, project, run, path[3])
		}
		if (request.method === 'POST' && path[2] === 'finish' && path.length === 3) {
			await services.db.finishRun(runId)
			return json({ ok: true })
		}
	}

	return notFound()
}

/**
 * Machine reads (GET) for `opice failures` + the agent read DSN — REST mirrors of the share
 * router's read procedures, gated by the service principal's report.read (checked by the caller).
 *   GET runs/<runId>                  → the run
 *   GET runs/<runId>/scenarios        → its scenarios
 *   GET scenarios/<scenarioId>/steps  → a scenario's steps
 *   GET screenshots/<key...>          → a screenshot (R2 proxy)
 *   GET videos/<key...>               → a scenario walkthrough video (R2 proxy)
 */
async function handleRead(services: Services, project: Project, path: string[]): Promise<Response> {
	if (path[0] === 'runs' && path[1]) {
		const run = await services.db.getRun(path[1])
		if (!run || run.projectId !== project.id) {
			return notFound('run not found')
		}
		if (path.length === 2) {
			return json(run)
		}
		if (path[2] === 'scenarios' && path.length === 3) {
			const scenarios = await services.db.listScenariosForRun(run.id)
			return json(withVideoUrl(scenarios, `/api/v1/${project.slug}/videos`))
		}
	}

	if (path[0] === 'scenarios' && path[1] && path[2] === 'steps' && path.length === 3) {
		const scenario = await services.db.getScenario(path[1])
		if (!scenario) {
			return notFound('scenario not found')
		}
		const run = await services.db.getRun(scenario.runId)
		if (!run || run.projectId !== project.id) {
			return notFound('scenario not found')
		}
		const steps = await services.db.listStepsForScenario(scenario.id)
		return json(steps.map(s => ({ ...s, screenshotUrl: s.screenshotKey ? `/api/v1/${project.slug}/screenshots/${s.screenshotKey}` : null })))
	}

	if (path[0] === 'screenshots' && path.length > 1) {
		return readAsset(services, project, path.slice(1).join('/'), 'image/png')
	}
	if (path[0] === 'videos' && path.length > 1) {
		return readAsset(services, project, path.slice(1).join('/'), 'video/webm')
	}

	return notFound()
}

/**
 * Stream a run asset (`<slug>/<runId>/...`) from the run-assets bucket to a
 * machine reader (agent read DSN / `opice failures`). Serves both step
 * screenshots and scenario videos. A read token may only fetch keys in its own
 * project (the key's leading slug must match); the body is served by `serveR2Asset`.
 */
async function readAsset(services: Services, project: Project, key: string, fallbackType: string): Promise<Response> {
	if ((key.split('/')[0] ?? '') !== project.slug) {
		return notFound()
	}
	return serveR2Asset(services.runAssets, key, fallbackType)
}

async function createRun(request: Request, services: Services, project: Project): Promise<Response> {
	const body = (await readJson<{ branch?: string; commit?: string; commitTime?: number; source?: string; tier?: string }>(request)) ?? {}
	const source = body.source === 'ci' || body.source === 'local' ? body.source : undefined
	const tier = typeof body.tier === 'string' ? body.tier : undefined
	const commitTime = typeof body.commitTime === 'number' && Number.isFinite(body.commitTime) ? body.commitTime : undefined
	const run = await services.db.createRun({ id: crypto.randomUUID(), projectId: project.id, branch: body.branch, commit: body.commit, commitTime, source, tier })
	return json({ runId: run.id })
}

async function createScenario(request: Request, services: Services, runId: string): Promise<Response> {
	const body = await readJson<{
		name?: string
		hash?: string
		testFile?: string
		scenarioFile?: string
		feature?: string
		seeds?: unknown
		roles?: unknown
		tier?: string
		skipped?: boolean
		reason?: string
	}>(request)
	if (!body?.name) {
		return badRequest('name is required')
	}
	const id = crypto.randomUUID()
	await services.db.createScenario({
		id,
		runId,
		name: body.name,
		hash: body.hash,
		testFile: body.testFile,
		scenarioFile: body.scenarioFile,
		feature: body.feature,
		seeds: toStringArray(body.seeds),
		roles: toStringArray(body.roles),
		tier: typeof body.tier === 'string' ? body.tier : undefined,
		skipped: body.skipped === true,
		skipReason: typeof body.reason === 'string' ? body.reason : undefined,
	})
	return json({ scenarioId: id })
}

/** Accept a string[] from the reporter, ignoring anything that isn't one. */
function toStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const out = value.filter((v): v is string => typeof v === 'string')
	return out.length > 0 ? out : undefined
}

async function finishScenario(request: Request, services: Services, scenarioId: string): Promise<Response> {
	const body = await readJson<{ status?: ScenarioStatus; durationMs?: number; attempts?: number }>(request)
	if (!body?.status || !ACCEPTED_SCENARIO_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
		return badRequest('status (passed|failed) and durationMs are required')
	}
	await services.db.finishScenario({
		id: scenarioId,
		status: body.status,
		durationMs: body.durationMs,
		attempts: typeof body.attempts === 'number' ? body.attempts : undefined,
	})
	return json({ ok: true })
}

async function createStep(
	request: Request,
	services: Services,
	project: Project,
	runId: string,
	scenarioId: string,
): Promise<Response> {
	const body = await readJson<{
		attempt?: number
		sequence?: number
		kind?: StepKind
		name?: string
		status?: StepStatus
		durationMs?: number
		error?: string
		intent?: string
		manual?: string
		reason?: string
		screenshot?: string
	}>(request)
	if (!body?.name || !body.status || !ACCEPTED_STEP_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
		return badRequest('name, status (passed|failed|fixme|fixmepass|pending), durationMs are required')
	}

	const stepId = await services.db.createStep({
		scenarioId,
		attempt: typeof body.attempt === 'number' ? body.attempt : undefined,
		sequence: typeof body.sequence === 'number' ? body.sequence : undefined,
		kind: body.kind && ACCEPTED_STEP_KINDS.includes(body.kind) ? body.kind : 'step',
		name: body.name,
		status: body.status,
		durationMs: body.durationMs,
		error: body.error,
		intent: body.intent,
		manual: body.manual,
		reason: body.reason,
	})

	let screenshotFailed = false
	if (body.screenshot) {
		const key = `${project.slug}/${runId}/step-${stepId}.png`
		// The screenshot is non-essential telemetry — the step row is already
		// written. R2 occasionally answers `put` with a transient internal error
		// ("...Please try again. (10001)"); retry it, and if it still fails (or the
		// base64 is malformed), log and move on rather than 500-ing the whole step
		// ingest (which, under the reporter's strict mode, would fail the CI run
		// over a flaky screenshot). Decoding is inside the try for the same reason.
		try {
			const bytes = base64ToBytes(body.screenshot)
			await putWithRetry(services.runAssets, key, bytes, { httpMetadata: { contentType: 'image/png' } })
			await services.db.attachScreenshot(stepId, key)
		} catch (err) {
			screenshotFailed = true
			console.error(`screenshot upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
			// Flag the step so the dashboard shows the gap (best-effort — a failed
			// flag write just leaves it looking like a step with no screenshot).
			try {
				await services.db.markScreenshotFailed(stepId)
			} catch (markErr) {
				console.error(`could not flag screenshot failure for ${key}: ${markErr instanceof Error ? markErr.message : String(markErr)}`)
			}
		}
	}

	// `screenshotFailed` lets the runner surface the dropped screenshot in the run
	// log without making it a reporting failure (the step itself was recorded).
	return json({ stepId, screenshotFailed })
}

/**
 * Largest video body we'll buffer + store. A walkthrough webm is normally a few
 * MB; this guards the Worker's memory against a pathological upload (we buffer
 * the whole body so `putWithRetry` can re-send it on a transient R2 error).
 */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024

/**
 * Read a per-scenario asset body (a video, a footprint), rejecting the
 * malformed cases the same way for both.
 *
 * Screenshots, videos and footprints are one asset family on this worker — one
 * bucket, one `<slug>/<runId>/…` namespace, one set of scope checks — so their
 * intake behaves identically too: the scenario must belong to the run, the body
 * must be non-empty, and an over-size body is refused up front from the declared
 * `content-length` before it is ever buffered. Returns the body together with
 * the scenario it belongs to (both callers need it), or the `Response` to send
 * instead.
 */
async function readScenarioAssetBody(
	request: Request,
	services: Services,
	runId: string,
	scenarioId: string,
	limits: { maxBytes: number; label: string },
): Promise<{ body: ArrayBuffer; scenario: Scenario } | { response: Response }> {
	const scenario = await services.db.getScenario(scenarioId)
	if (!scenario || scenario.runId !== runId) {
		return { response: notFound('scenario not found') }
	}
	const declared = Number(request.headers.get('content-length') ?? '')
	if (Number.isFinite(declared) && declared > limits.maxBytes) {
		return { response: badRequest(`${limits.label} too large (${declared} bytes > ${limits.maxBytes})`) }
	}
	const body = await request.arrayBuffer()
	if (body.byteLength === 0) {
		return { response: badRequest(`empty ${limits.label} body`) }
	}
	if (body.byteLength > limits.maxBytes) {
		return { response: badRequest(`${limits.label} too large (${body.byteLength} bytes > ${limits.maxBytes})`) }
	}
	return { body, scenario }
}

/**
 * Receive a scenario's walkthrough video (opt-in, `OPICE_VIDEO`) and store it in
 * the shared run-assets bucket. The video is non-essential telemetry, exactly
 * like a step screenshot: the scenario row already exists, so a *storage*
 * failure is reported as `{ videoFailed: true }` (HTTP 200) rather than 500-ing
 * — which, under the reporter's strict mode, would fail the CI run over a
 * dropped video.
 */
async function uploadVideo(
	request: Request,
	services: Services,
	project: Project,
	runId: string,
	scenarioId: string,
): Promise<Response> {
	const read = await readScenarioAssetBody(request, services, runId, scenarioId, { maxBytes: MAX_VIDEO_BYTES, label: 'video' })
	if ('response' in read) return read.response
	const key = `${project.slug}/${runId}/video-${scenarioId}.webm`
	try {
		await putWithRetry(services.runAssets, key, new Uint8Array(read.body), { httpMetadata: { contentType: 'video/webm' } })
		await services.db.attachVideo(scenarioId, key)
	} catch (err) {
		console.error(`video upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
		return json({ videoFailed: true })
	}
	return json({ ok: true, videoKey: key })
}

/** Most changed paths one impact query will consider. A diff past this is a rewrite, not a change. */
const MAX_IMPACT_PATHS = 2000

/**
 * Which scenarios does a change reach?
 *
 * Answers with the matched scenarios AND with the state of the index itself
 * (`indexed`, `updatedAt`), because those are what tell an empty answer apart
 * from a meaningless one. "No scenario touches these files" and "no footprint
 * has ever been recorded" both produce zero scenarios, and a caller that can't
 * distinguish them will either skip tests it needed or run everything forever.
 * The CLI prints the difference and fails open on the second.
 */
async function impact(request: Request, services: Services, project: Project): Promise<Response> {
	const body = (await readJson<{ paths?: unknown; models?: unknown; includeLoaded?: unknown }>(request)) ?? {}
	const paths = toStringArray(body.paths) ?? []
	const models = toStringArray(body.models) ?? []
	if (paths.length > MAX_IMPACT_PATHS) {
		return badRequest(`too many paths (${paths.length} > ${MAX_IMPACT_PATHS})`)
	}
	const includeLoaded = body.includeLoaded === true
	const [edges, index] = await Promise.all([
		services.db.listImpactEdges(project.id, includeLoaded),
		// The dimensions THIS query depends on: paths match file and component
		// edges, models match model edges. Asking about the others would report a
		// gap the caller does not care about.
		services.db.footprintIndexStatus(project.id, models.length > 0 ? ['file', 'model'] : ['file']),
	])
	const scenarios = matchImpact(edges, { paths, models, includeLoaded })
	return json({ scenarios, index })
}

/**
 * Largest footprint we'll accept. The harness already caps what it collects
 * (2000 requests, 5000 files) and reports when it truncated, so anything past
 * this is a client that isn't ours.
 */
const MAX_FOOTPRINT_BYTES = 8 * 1024 * 1024

/**
 * Receive a scenario's footprint (opt-in, `OPICE_FOOTPRINT`) and do two things
 * with it.
 *
 * The **blob** goes to R2 beside the run's screenshots and video, so the
 * dashboard can show what that particular run's scenario touched. Best-effort,
 * like the other two: a storage failure answers 200 with `{ footprintFailed:
 * true }` rather than 500-ing, because the reporter's strict mode would
 * otherwise fail a CI run over dropped telemetry.
 *
 * The **edges** go to the change-tracking index — but only for CI runs. A local
 * run happens against whatever half-built state is on someone's laptop, and
 * letting it rewrite the shared index is the one way `--impacted` could start
 * quietly selecting the wrong tests for everybody. The blob is still stored for
 * a local run; only the index is protected.
 */
async function uploadFootprint(
	request: Request,
	services: Services,
	project: Project,
	run: Run,
	scenarioId: string,
): Promise<Response> {
	const read = await readScenarioAssetBody(request, services, run.id, scenarioId, { maxBytes: MAX_FOOTPRINT_BYTES, label: 'footprint' })
	if ('response' in read) return read.response
	const bytes = new Uint8Array(read.body)
	let footprint: ScenarioFootprint
	try {
		footprint = normalizeFootprint(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
	} catch (err) {
		return badRequest(`invalid footprint: ${err instanceof Error ? err.message : String(err)}`)
	}
	const scenario = read.scenario

	const key = `${project.slug}/${run.id}/footprint-${scenarioId}.json`
	let footprintFailed = false
	try {
		// The SANITIZED document is what gets stored — never the bytes that arrived.
		// `normalizeFootprint` rebuilds every request from an allow-list, and this is
		// what makes that hold: persisting the original body would keep whatever
		// extra fields a client sent, and the RPC would hand them back out, including
		// to run-share holders.
		const sanitized = new TextEncoder().encode(JSON.stringify(footprint))
		await putWithRetry(services.runAssets, key, sanitized, { httpMetadata: { contentType: 'application/json' } })
		await services.db.attachFootprint(scenarioId, key, summarize(footprint))
	} catch (err) {
		footprintFailed = true
		console.error(`footprint upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
	}

	// Three gates before this footprint may rewrite the shared index. It must come
	// from CI and from the default branch (see migration 0012 for why) — and the
	// walkthrough must have COMPLETED. A scenario that failed part-way touched a
	// prefix of what it covers, and edges are replaced wholesale, so indexing that
	// prefix would delete the valid ones and quietly stop selecting the scenario
	// for everything it never reached. The blob is stored regardless of all three.
	// Explicit opt-in, not opt-out: a client that doesn't say the walkthrough
	// finished hasn't proved it did. An older harness omits the parameter
	// entirely, and treating that silence as "complete" would let it replace a
	// scenario's valid edges with whatever it managed to collect.
	const complete = new URL(request.url).searchParams.get('complete') === 'true'
	// A completed walkthrough still only speaks for the dimensions it actually
	// measured; with none of them there is nothing to index.
	const kinds = indexableKinds(footprint)
	let indexed = false
	if (complete && kinds.length > 0 && run.source === 'ci' && isDefaultBranch(project, run.branch)) {
		try {
			const replaced = await services.db.replaceFootprintEdges({
				projectId: project.id,
				scenarioKey: scenarioKeyOf(scenario.testFile, scenario.name),
				testFile: scenario.testFile,
				scenarioName: scenario.name,
				runId: run.id,
				branch: run.branch,
				// The COMMIT's time, falling back to the run's start when a client
				// doesn't report one — see migration 0012.
				runStartedAt: run.commitTime ?? run.startedAt,
				// Only the dimensions this run actually measured, whole. A run that saw
				// no files (network mode against a bundle, no source maps) must not
				// delete the file edges a fuller run established — that would shrink
				// `--impacted` silently, which is worse than not indexing at all.
				kinds,
				edges: toEdges(footprint, kinds),
			})
			// False when a NEWER run already indexed this scenario — the write was
			// correctly refused rather than having failed.
			indexed = replaced.applied
		} catch (err) {
			// The index is a derived convenience; the blob above is the record. A
			// failure here degrades `--impacted`, it doesn't lose data.
			console.error(`footprint indexing failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
		}
	}
	return json({ ok: !footprintFailed, footprintFailed, indexed })
}

/**
 * Retry an R2 `put` through transient internal errors (code 10001). R2 surfaces
 * these as a thrown Error; a short backoff usually clears them. Stays well inside
 * the request budget — at most a couple of attempts with sub-second waits.
 */
async function putWithRetry(bucket: R2Bucket, key: string, bytes: Uint8Array, options: R2PutOptions): Promise<void> {
	const backoffMs = [150, 500]
	for (let attempt = 0; ; attempt++) {
		try {
			await bucket.put(key, bytes, options)
			return
		} catch (err) {
			const delay = backoffMs[attempt]
			if (delay === undefined) throw err
			await new Promise(resolve => setTimeout(resolve, delay))
		}
	}
}

function base64ToBytes(b64: string): Uint8Array {
	const stripped = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64
	const binary = atob(stripped)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}
