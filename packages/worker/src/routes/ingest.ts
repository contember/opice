import { badRequest, json, notFound, readJson, unauthorized } from '../http'
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
			return json(await services.db.listScenariosForRun(run.id))
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
		return readScreenshot(services, project, path.slice(1).join('/'))
	}

	return notFound()
}

async function readScreenshot(services: Services, project: Project, key: string): Promise<Response> {
	// The R2 key is `<slug>/<runId>/...`; a read token may only fetch its own project's keys.
	if ((key.split('/')[0] ?? '') !== project.slug) {
		return notFound()
	}
	const obj = await services.screenshots.get(key)
	if (!obj) {
		return notFound()
	}
	return new Response(obj.body, {
		headers: {
			'content-type': obj.httpMetadata?.contentType ?? 'image/png',
			'cache-control': 'public, max-age=3600',
		},
	})
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
			await putWithRetry(services.screenshots, key, bytes, { httpMetadata: { contentType: 'image/png' } })
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
