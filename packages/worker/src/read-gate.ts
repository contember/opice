/**
 * Read gate for the dashboard, RPC, and screenshots.
 *
 * A token resolves to a *scope*:
 *   - `all`     — the global READ_TOKEN (the dashboard owner): sees everything.
 *   - `project` — a per-project read token: scoped to that one project's data.
 *
 * Tokens arrive via `?token=<token>` (CLI / shared links) or the `opice_read`
 * cookie (browser, set once after the first visit with `?token=`).
 *
 * A logged-in BetterAuth session (the operator) always resolves to `all` —
 * login is the owner's way in; read tokens stay for shareable read-only links.
 *
 * Local dev convenience: when the global READ_TOKEN is empty the gate is
 * disabled entirely (everything resolves to `all`).
 */

import type { Services } from './services'

export type ReadScope = { kind: 'all' } | { kind: 'project'; projectId: number; slug: string }

const COOKIE = 'opice_read'

function extractToken(request: Request): string | null {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (queryToken) return queryToken
	const cookies = request.headers.get('cookie') ?? ''
	for (const part of cookies.split(';')) {
		const [k, v] = part.trim().split('=')
		if (k === COOKIE && v) return v
	}
	return null
}

/** Resolve the caller's read scope, or `null` if the token is missing/invalid. */
export async function resolveReadScope(request: Request, services: Services): Promise<ReadScope | null> {
	const expected = services.config.readToken
	// Empty global token → gate disabled (local dev).
	if (!expected) return { kind: 'all' }

	// A logged-in operator sees everything. Cheap when BetterAuth's cookie cache
	// is warm; only hits AUTH_DB once per cache window.
	if (await hasSession(request, services)) return { kind: 'all' }

	const token = extractToken(request)
	if (!token) return null
	if (token === expected) return { kind: 'all' }

	const project = await services.db.getProjectByReadToken(token)
	if (project) return { kind: 'project', projectId: project.id, slug: project.slug }
	return null
}

async function hasSession(request: Request, services: Services): Promise<boolean> {
	// No cookies → definitely no session; skip the auth machinery entirely.
	if (!request.headers.get('cookie')) return false
	try {
		const session = await services.auth.api.getSession({ headers: request.headers })
		return session !== null
	} catch {
		return false
	}
}

/** Whether a scope is allowed to read data belonging to `projectId`. */
export function projectAllowed(scope: ReadScope, projectId: number): boolean {
	return scope.kind === 'all' || scope.projectId === projectId
}

/** Whether a scope is allowed to read a screenshot R2 key (`<slug>/<run>/...`). */
export function screenshotKeyAllowed(scope: ReadScope, key: string): boolean {
	return scope.kind === 'all' || key.startsWith(`${scope.slug}/`)
}

/**
 * If the request carries a valid `?token=` in the query, exchange it for the
 * `opice_read` cookie and redirect to the token-stripped URL. Returns null when
 * there's nothing to exchange.
 */
export async function readAccessRedirect(request: Request, services: Services): Promise<Response | null> {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (!queryToken) return null
	const scope = await resolveReadScope(request, services)
	if (!scope) return null

	const next = new URL(url.toString())
	next.searchParams.delete('token')
	return new Response(null, {
		status: 302,
		headers: {
			location: next.toString(),
			'set-cookie': `${COOKIE}=${queryToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
		},
	})
}
