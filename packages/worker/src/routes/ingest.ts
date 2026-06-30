import { withVideoUrl } from '../asset-url'
import { badRequest, json, notFound, readJson, serveR2Asset, unauthorized } from '../http'
import { machineCanReadReports, machineCanWriteReports, resolveMachine } from '../principal'
import type { Services } from '../services'
import type { Project, ScenarioStatus, StepKind, StepStatus } from '../types'

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
	const body = (await readJson<{ branch?: string; commit?: string; source?: string; tier?: string }>(request)) ?? {}
	const source = body.source === 'ci' || body.source === 'local' ? body.source : undefined
	const tier = typeof body.tier === 'string' ? body.tier : undefined
	const run = await services.db.createRun({ id: crypto.randomUUID(), projectId: project.id, branch: body.branch, commit: body.commit, source, tier })
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
 * Receive a scenario's walkthrough video (opt-in, `OPICE_VIDEO`) as a binary PUT
 * and store it in the shared run-assets bucket under `<slug>/<runId>/...`. The
 * video is non-essential telemetry, exactly like a step screenshot: the scenario
 * row already exists, so a *storage* failure is logged and reported as
 * `{ videoFailed: true }` (HTTP 200) rather than 500-ing — which, under the
 * reporter's strict mode, would fail the CI run over a dropped video. A malformed
 * request (empty or over-size body) is a genuine 400, not a storage failure; the
 * reporter treats any non-2xx as best-effort and never reds the run either way.
 */
async function uploadVideo(
	request: Request,
	services: Services,
	project: Project,
	runId: string,
	scenarioId: string,
): Promise<Response> {
	const scenario = await services.db.getScenario(scenarioId)
	if (!scenario || scenario.runId !== runId) {
		return notFound('scenario not found')
	}
	// Reject an over-size body up front when the length is declared, before buffering.
	const declared = Number(request.headers.get('content-length') ?? '')
	if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
		return badRequest(`video too large (${declared} bytes > ${MAX_VIDEO_BYTES})`)
	}
	const buffer = await request.arrayBuffer()
	if (buffer.byteLength === 0) {
		return badRequest('empty video body')
	}
	if (buffer.byteLength > MAX_VIDEO_BYTES) {
		return badRequest(`video too large (${buffer.byteLength} bytes > ${MAX_VIDEO_BYTES})`)
	}
	const key = `${project.slug}/${runId}/video-${scenarioId}.webm`
	try {
		await putWithRetry(services.runAssets, key, new Uint8Array(buffer), { httpMetadata: { contentType: 'video/webm' } })
		await services.db.attachVideo(scenarioId, key)
	} catch (err) {
		console.error(`video upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`)
		return json({ videoFailed: true })
	}
	return json({ ok: true, videoKey: key })
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
