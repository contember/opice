import { authenticateAdmin, generateApiKey, generateReadToken, hashApiKey } from '../auth'
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
	// POST /api/v1/admin/projects/:slug/read-token — (re)generate a read token.
	if (request.method === 'POST' && path[0] === 'projects' && path[1] && path[2] === 'read-token' && path.length === 3) {
		return rotateReadToken(services, path[1])
	}
	// POST /api/v1/admin/users — create a dashboard login (every user is admin).
	if (request.method === 'POST' && path[0] === 'users' && path.length === 1) {
		return createUser(request, services)
	}
	return notFound()
}

interface CreateUserInput {
	email?: string
	password?: string
	name?: string
}

async function createUser(request: Request, services: Services): Promise<Response> {
	const body = await safeJson<CreateUserInput>(request)
	if (!body?.email || !body.password) {
		return badRequest('email and password are required')
	}
	// Public signup is blocked at the route layer; this server-side call is the
	// sanctioned path. BetterAuth requires a non-null name → fall back to the
	// email's local part.
	const name = body.name?.trim() || body.email.split('@')[0] || body.email
	try {
		const result = await services.auth.api.signUpEmail({
			body: { email: body.email, password: body.password, name },
		})
		return json({ id: result.user.id, email: result.user.email, name: result.user.name })
	} catch (err) {
		const status = (err as { statusCode?: number }).statusCode
		const message = (err as { body?: { message?: string } }).body?.message ?? (err as Error).message ?? 'failed to create user'
		if (status === 422 || /exist/i.test(message)) {
			return conflict('a user with that email already exists')
		}
		return badRequest(message)
	}
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
	const readToken = generateReadToken()
	const project = await services.db.createProject({ slug: body.slug, name: body.name, apiKeyHash, readToken })
	return json({ id: project.id, slug: project.slug, name: project.name, apiKey, readToken })
}

async function rotateReadToken(services: Services, slug: string): Promise<Response> {
	const project = await services.db.getProjectBySlug(slug)
	if (!project) {
		return notFound('project not found')
	}
	const readToken = generateReadToken()
	await services.db.setReadToken(slug, readToken)
	return json({ slug, readToken })
}

async function safeJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T
	} catch {
		return null
	}
}
