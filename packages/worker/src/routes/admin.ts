import { authenticateAdmin, generateApiKey, hashApiKey } from '../auth'
import { badRequest, conflict, json, notFound, unauthorized } from '../http'
import type { Services } from '../services'

interface CreateProjectInput {
	slug?: string
	name?: string
}

export async function handleAdmin(request: Request, services: Services, path: string[]): Promise<Response> {
	if (!authenticateAdmin(request, services.config.adminToken)) {
		return unauthorized()
	}
	if (request.method === 'POST' && path[0] === 'projects' && path.length === 1) {
		return createProject(request, services)
	}
	return notFound()
}

async function createProject(request: Request, services: Services): Promise<Response> {
	const body = await safeJson<CreateProjectInput>(request)
	if (!body?.slug || !body.name) {
		return badRequest('slug and name are required')
	}
	const existing = await services.db.getProjectBySlug(body.slug)
	if (existing) {
		return conflict('slug already exists')
	}
	const apiKey = generateApiKey()
	const apiKeyHash = await hashApiKey(apiKey)
	const project = await services.db.createProject({ slug: body.slug, name: body.name, apiKeyHash })
	return json({ id: project.id, slug: project.slug, name: project.name, apiKey })
}

async function safeJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T
	} catch {
		return null
	}
}
