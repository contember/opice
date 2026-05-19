import { authenticateProject, hashApiKey } from './auth'
import type { Db } from './db'
import type { Project } from './types'

interface Env {
	DB: D1Database
	SCREENSHOTS: R2Bucket
	ADMIN_TOKEN?: string
}

function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	})
}

function badRequest(message: string): Response {
	return json({ error: message }, { status: 400 })
}

function notFound(message: string = 'not found'): Response {
	return json({ error: message }, { status: 404 })
}

function unauthorized(): Response {
	return json({ error: 'unauthorized' }, { status: 401 })
}

function uuid(): string {
	return crypto.randomUUID()
}

async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T
	} catch {
		return null
	}
}

function screenshotKey(projectSlug: string, runId: string, stepId: number): string {
	return `${projectSlug}/${runId}/step-${stepId}.png`
}

export async function handleApi(
	request: Request,
	env: Env,
	db: Db,
	path: string[],
): Promise<Response> {
	// path is the segments after /api/v1/
	// Admin endpoints (token-gated, not project-scoped).
	if (path[0] === 'admin') {
		return handleAdmin(request, env, path.slice(1))
	}

	const project = await authenticateProject(request, env.DB)
	if (!project) {
		return unauthorized()
	}

	const method = request.method

	// POST /api/v1/runs
	if (method === 'POST' && path.length === 1 && path[0] === 'runs') {
		return createRun(request, db, project)
	}

	// /api/v1/runs/:id/...
	if (path[0] === 'runs' && path[1]) {
		const runId = path[1]
		const run = await db.getRun(runId)
		if (!run || run.project_id !== project.id) {
			return notFound('run not found')
		}

		// POST /api/v1/runs/:id/scenarios
		if (method === 'POST' && path[2] === 'scenarios' && path.length === 3) {
			return createScenario(request, db, runId)
		}

		// PATCH /api/v1/runs/:id/scenarios/:sid
		if (method === 'PATCH' && path[2] === 'scenarios' && path[3] && path.length === 4) {
			return finishScenario(request, db, path[3])
		}

		// POST /api/v1/runs/:id/scenarios/:sid/steps
		if (method === 'POST' && path[2] === 'scenarios' && path[3] && path[4] === 'steps' && path.length === 5) {
			return createStep(request, env, db, project, runId, path[3])
		}

		// POST /api/v1/runs/:id/finish
		if (method === 'POST' && path[2] === 'finish' && path.length === 3) {
			await db.finishRun(runId, Date.now())
			return json({ ok: true })
		}
	}

	return notFound()
}

async function createRun(request: Request, db: Db, project: Project): Promise<Response> {
	const body = (await readJson<{ branch?: string; commit?: string }>(request)) ?? {}
	const id = uuid()
	await db.createRun({
		id,
		projectId: project.id,
		branch: body.branch,
		commit: body.commit,
		startedAt: Date.now(),
	})
	return json({ runId: id })
}

async function createScenario(request: Request, db: Db, runId: string): Promise<Response> {
	const body = await readJson<{ name?: string; hash?: string }>(request)
	if (!body?.name) {
		return badRequest('name is required')
	}
	const id = uuid()
	await db.createScenario({
		id,
		runId,
		name: body.name,
		hash: body.hash,
		startedAt: Date.now(),
	})
	return json({ scenarioId: id })
}

async function finishScenario(request: Request, db: Db, scenarioId: string): Promise<Response> {
	const body = await readJson<{ status?: 'passed' | 'failed'; durationMs?: number }>(request)
	if (!body?.status || typeof body.durationMs !== 'number') {
		return badRequest('status and durationMs are required')
	}
	await db.finishScenario({
		id: scenarioId,
		status: body.status,
		durationMs: body.durationMs,
		finishedAt: Date.now(),
	})
	return json({ ok: true })
}

async function createStep(
	request: Request,
	env: Env,
	db: Db,
	project: Project,
	runId: string,
	scenarioId: string,
): Promise<Response> {
	const body = await readJson<{
		name?: string
		status?: 'passed' | 'failed'
		durationMs?: number
		error?: string
		screenshot?: string // base64 PNG (optional)
	}>(request)
	if (!body?.name || !body.status || typeof body.durationMs !== 'number') {
		return badRequest('name, status, durationMs are required')
	}

	const stepId = await db.createStep({
		scenarioId,
		name: body.name,
		status: body.status,
		durationMs: body.durationMs,
		error: body.error,
	})

	if (body.screenshot) {
		const key = screenshotKey(project.slug, runId, stepId)
		const bytes = base64ToBytes(body.screenshot)
		await env.SCREENSHOTS.put(key, bytes, {
			httpMetadata: { contentType: 'image/png' },
		})
		await env.DB
			.prepare('UPDATE steps SET screenshot_r2_key = ? WHERE id = ?')
			.bind(key, stepId)
			.run()
	}

	return json({ stepId })
}

async function handleAdmin(request: Request, env: Env, path: string[]): Promise<Response> {
	const token = request.headers.get('x-admin-token')
	if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
		return unauthorized()
	}
	if (request.method === 'POST' && path[0] === 'projects' && path.length === 1) {
		const body = await readJson<{ slug?: string; name?: string }>(request)
		if (!body?.slug || !body.name) {
			return badRequest('slug and name are required')
		}
		const existing = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?').bind(body.slug).first()
		if (existing) {
			return json({ error: 'slug already exists' }, { status: 409 })
		}
		const apiKey = generateApiKey()
		const hash = await hashApiKey(apiKey)
		const result = await env.DB
			.prepare('INSERT INTO projects (slug, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)')
			.bind(body.slug, body.name, hash, Date.now())
			.run()
		return json({ id: Number(result.meta.last_row_id), slug: body.slug, name: body.name, apiKey })
	}
	return notFound()
}

function generateApiKey(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
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
