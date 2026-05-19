import { authenticateProject } from '../auth'
import { badRequest, json, notFound, readJson, unauthorized } from '../http'
import type { Services } from '../services'
import type { Project, StepStatus } from '../types'

const ACCEPTED_STATUSES: readonly StepStatus[] = ['passed', 'failed']

export async function handleIngest(request: Request, services: Services, path: string[]): Promise<Response> {
	const project = await authenticateProject(request, services.db)
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
	const body = (await readJson<{ branch?: string; commit?: string }>(request)) ?? {}
	const run = await services.db.createRun({ id: crypto.randomUUID(), projectId: project.id, branch: body.branch, commit: body.commit })
	return json({ runId: run.id })
}

async function createScenario(request: Request, services: Services, runId: string): Promise<Response> {
	const body = await readJson<{ name?: string; hash?: string }>(request)
	if (!body?.name) {
		return badRequest('name is required')
	}
	const id = crypto.randomUUID()
	await services.db.createScenario({ id, runId, name: body.name, hash: body.hash })
	return json({ scenarioId: id })
}

async function finishScenario(request: Request, services: Services, scenarioId: string): Promise<Response> {
	const body = await readJson<{ status?: StepStatus; durationMs?: number }>(request)
	if (!body?.status || !ACCEPTED_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
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
		name?: string
		status?: StepStatus
		durationMs?: number
		error?: string
		screenshot?: string
	}>(request)
	if (!body?.name || !body.status || !ACCEPTED_STATUSES.includes(body.status) || typeof body.durationMs !== 'number') {
		return badRequest('name, status (passed|failed), durationMs are required')
	}

	const stepId = await services.db.createStep({
		scenarioId,
		name: body.name,
		status: body.status,
		durationMs: body.durationMs,
		error: body.error,
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
