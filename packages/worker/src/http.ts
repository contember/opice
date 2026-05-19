/**
 * Tiny response builders used by every route. Centralized so the JSON
 * envelope, headers, and status mapping stay consistent.
 */

export function json(data: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
	})
}

export function badRequest(message: string): Response {
	return json({ error: message }, { status: 400 })
}

export function unauthorized(message = 'unauthorized'): Response {
	return json({ error: message }, { status: 401 })
}

export function forbidden(message = 'forbidden'): Response {
	return new Response(message, { status: 403 })
}

export function notFound(message = 'not found'): Response {
	return json({ error: message }, { status: 404 })
}

export function conflict(message: string): Response {
	return json({ error: message }, { status: 409 })
}

export async function readJson<T>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T
	} catch {
		return null
	}
}
