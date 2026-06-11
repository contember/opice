import { badRequest, json, notFound, readJson, unauthorized } from '../http'
import { capCanWriteProject, redeemBearerCapability } from '../principal'
import type { Services } from '../services'
import type { Project, ScenarioStatus, StepKind, StepStatus } from '../types'

// Steps accept the tolerated fixme markers + 'pending' (a phase-1 stub); scenario
// finish does not (a scenario is only ever passed/failed — fixme/pending surface
// as derived warning/incomplete).
const ACCEPTED_STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'fixme', 'fixmepass', 'pending']
const ACCEPTED_STEP_KINDS: readonly StepKind[] = ['step', 'invariant']
const ACCEPTED_SCENARIO_STATUSES: readonly ScenarioStatus[] = ['passed', 'failed']

/**
 * Ingest (`/api/v1/<slug>/...`) — PUBLIC (outside Access), authenticated by a propustka INGEST
 * CAPABILITY token (the reporter's OPICE_DSN) presented as `Authorization: Bearer`. The Worker
 * redeems it over the IAM binding and checks `report.write` on the project named in the URL —
 * the slug comes from the path (no opice token, no grant enumeration). The binding does not
 * traverse Access, which is why ingest can be public.
 */
export async function handleIngest(request: Request, services: Services, segments: string[]): Promise<Response> {
	const slug = segments[0]
	const path = segments.slice(1)
	if (!slug) {
		return notFound()
	}
	const cap = await redeemBearerCapability(request, services)
	if (!cap || !capCanWriteProject(cap, slug)) {
		return unauthorized()
	}
	const project = await services.db.getProjectBySlug(slug)
	if (!project) {
		return unauthorized()
	}

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

async function createRun(request: Request, services: Services, project: Project): Promise<Response> {
	const body = (await readJson<{ branch?: string; commit?: string; source?: string }>(request)) ?? {}
	const source = body.source === 'ci' || body.source === 'local' ? body.source : undefined
	const run = await services.db.createRun({ id: crypto.randomUUID(), projectId: project.id, branch: body.branch, commit: body.commit, source })
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

	if (body.screenshot) {
		const key = `${project.slug}/${runId}/step-${stepId}.png`
		const bytes = base64ToBytes(body.screenshot)
		await services.screenshots.put(key, bytes, { httpMetadata: { contentType: 'image/png' } })
		await services.db.attachScreenshot(stepId, key)
	}

	return json({ stepId })
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
