import { badRequest, json, notFound, readJson, unauthorized } from '../http'
import { authenticate, has } from '../principal'
import type { Services } from '../services'
import type { Project, ScenarioStatus, StepStatus } from '../types'

// Steps accept the tolerated fixme markers; scenario finish does not (a scenario
// is only ever passed/failed — a fixme step surfaces as a derived warning).
const ACCEPTED_STEP_STATUSES: readonly StepStatus[] = ['passed', 'failed', 'fixme', 'fixmepass']
const ACCEPTED_SCENARIO_STATUSES: readonly ScenarioStatus[] = ['passed', 'failed']

export async function handleIngest(request: Request, services: Services, path: string[]): Promise<Response> {
	// Ingest needs a write capability scoped to exactly one project: a CI/local
	// write token. (Sessions and admin tokens carry write too, but the scope must
	// resolve to a single project — reporting always targets one project.)
	const principal = await authenticate(request, services)
	if (!principal || !has(principal, 'write') || principal.scope.kind !== 'project') {
		return unauthorized()
	}
	const project = await services.db.getProjectBySlug(principal.scope.slug)
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
	const body = await readJson<{ name?: string; hash?: string; testFile?: string; scenarioFile?: string }>(request)
	if (!body?.name) {
		return badRequest('name is required')
	}
	const id = crypto.randomUUID()
	await services.db.createScenario({ id, runId, name: body.name, hash: body.hash, testFile: body.testFile, scenarioFile: body.scenarioFile })
	return json({ scenarioId: id })
}

async function finishScenario(request: Request, services: Services, scenarioId: string): Promise<Response> {
	const body = await readJson<{ status?: ScenarioStatus; durationMs?: number }>(request)
	if (!body?.status || !ACCEPTED_SCENARIO_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
		return badRequest('status (passed|failed) and durationMs are required')
	}
	await services.db.finishScenario({ id: scenarioId, status: body.status, durationMs: body.durationMs })
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
		sequence?: number
		name?: string
		status?: StepStatus
		durationMs?: number
		error?: string
		reason?: string
		screenshot?: string
	}>(request)
	if (!body?.name || !body.status || !ACCEPTED_STEP_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
		return badRequest('name, status (passed|failed|fixme|fixmepass), durationMs are required')
	}

	const stepId = await services.db.createStep({
		scenarioId,
		sequence: typeof body.sequence === 'number' ? body.sequence : undefined,
		name: body.name,
		status: body.status,
		durationMs: body.durationMs,
		error: body.error,
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
