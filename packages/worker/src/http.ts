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

/**
 * Stream a run asset (a step screenshot or scenario video) out of the assets R2
 * bucket. Shared by all three proxy planes (operator, share, machine) — they
 * differ only in the auth gate they run *before* calling this, not in how the
 * object is served. The stored object's content-type wins; `fallbackType` is
 * only used for a legacy object stored without one. 404s when the key is absent.
 */
export async function serveR2Asset(bucket: R2Bucket, key: string, fallbackType: string): Promise<Response> {
	const obj = await bucket.get(key)
	if (!obj) {
		return notFound()
	}
	return new Response(obj.body, {
		headers: {
			'content-type': obj.httpMetadata?.contentType ?? fallbackType,
			'cache-control': 'public, max-age=3600',
		},
	})
}
