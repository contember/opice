/**
 * Unified authorization. Every surface (ingest, rpc, screenshots, dashboard)
 * authenticates through one function — `authenticate(request)` — which resolves
 * any supported credential into a single `Principal`. Handlers then assert on
 * the principal's **capabilities** (what it may do) and **scope** (which data it
 * may touch); they never re-implement credential parsing.
 *
 * Credentials, in resolution order:
 *   1. a BetterAuth session cookie — a human operator, role → capabilities;
 *   2. `Authorization: Bearer <secret>` — a token row, or the bootstrap
 *      `ADMIN_TOKEN` root credential;
 *   3. `?token=` / the `opice_read` cookie — a read-only share link.
 *
 * Local dev (`ENVIRONMENT === 'local'`) is open: the Vite SPA runs cross-origin
 * and we don't want a cookie dance in front of every `/rpc` call.
 */

import type { Services } from './services'
import type { Capability, Token } from './types'

export type Scope =
	| { kind: 'all' }
	| { kind: 'project'; projectId: number; slug: string }
	| { kind: 'run'; projectId: number; slug: string; runId: string }

export interface Principal {
	/** Stable identifier for logs/audit, e.g. `user:abc`, `token:xyz`, `env:admin`. */
	subject: string
	capabilities: ReadonlySet<Capability>
	scope: Scope
}

export const READ_COOKIE = 'opice_read'

const ALL: ReadonlySet<Capability> = new Set<Capability>(['read', 'write', 'admin'])

function capabilitiesForRole(role: string | null | undefined): ReadonlySet<Capability> {
	// `member` is read+write (sees everything, can create projects + shares);
	// everything else (incl. the default `admin`) is full access. New accounts
	// are created as `admin` unless explicitly downgraded — see admin.createUser.
	if (role === 'member') return new Set<Capability>(['read', 'write'])
	return ALL
}

function capabilitiesForToken(capability: Capability): ReadonlySet<Capability> {
	switch (capability) {
		case 'read': return new Set<Capability>(['read'])
		case 'write': return new Set<Capability>(['write'])
		case 'admin': return ALL
	}
}

function scopeForToken(token: Token): Scope {
	if (token.projectId == null || token.projectSlug == null) return { kind: 'all' }
	if (token.runId != null) {
		return { kind: 'run', projectId: token.projectId, slug: token.projectSlug, runId: token.runId }
	}
	return { kind: 'project', projectId: token.projectId, slug: token.projectSlug }
}

export async function hashToken(secret: string): Promise<string> {
	const data = new TextEncoder().encode(secret)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateSecret(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function generateTokenId(): string {
	return crypto.randomUUID()
}

// ---- resolution -----------------------------------------------------------

export async function authenticate(request: Request, services: Services): Promise<Principal | null> {
	const session = await resolveSession(request, services)
	if (session) return session

	const bearer = extractBearer(request)
	if (bearer) {
		// A presented Bearer is an explicit credential claim — if it doesn't
		// resolve, reject rather than falling through to the local-dev opening.
		// This keeps ingest (which always presents a project-scoped write token)
		// resolving to its real project even in local dev.
		return resolveBearer(bearer, services)
	}

	const shared = extractSharedToken(request)
	if (shared) {
		const principal = await resolveShareToken(shared, services)
		if (principal) return principal
	}

	// Local dev: with no usable credential the gate is open, so the cross-origin
	// Vite SPA can hit /rpc and /screenshots without a cookie dance. Reporting
	// still presents a real token above and resolves to its project.
	if (services.config.environment === 'local') {
		return { subject: 'env:local', capabilities: ALL, scope: { kind: 'all' } }
	}

	return null
}

async function resolveSession(request: Request, services: Services): Promise<Principal | null> {
	// No cookies → no session; skip the auth machinery (and the AUTH_DB hit).
	if (!request.headers.get('cookie')) return null
	try {
		const session = await services.auth.api.getSession({ headers: request.headers })
		if (!session) return null
		const role = (session.user as { role?: string | null }).role
		return { subject: `user:${session.user.id}`, capabilities: capabilitiesForRole(role), scope: { kind: 'all' } }
	} catch {
		return null
	}
}

async function resolveBearer(bearer: string, services: Services): Promise<Principal | null> {
	const hash = await hashToken(bearer)
	// Bootstrap root admin: the ADMIN_TOKEN env secret. Compared as hashes so the
	// check is constant-time in the secret. Lets an operator mint the first
	// account / token before any session or token row exists.
	const adminToken = services.config.adminToken
	if (adminToken && hash === (await hashToken(adminToken))) {
		return { subject: 'env:admin', capabilities: ALL, scope: { kind: 'all' } }
	}
	return resolveTokenRow(hash, services)
}

async function resolveShareToken(secret: string, services: Services): Promise<Principal | null> {
	const principal = await resolveTokenRow(await hashToken(secret), services)
	// Share links are read-only by construction: never honour a write/admin
	// token presented via the query string or cookie.
	if (principal && principal.capabilities.has('read') && !principal.capabilities.has('write') && !principal.capabilities.has('admin')) {
		return principal
	}
	return null
}

async function resolveTokenRow(hash: string, services: Services): Promise<Principal | null> {
	const token = await services.db.getTokenByHash(hash)
	if (!token) return null
	if (token.revokedAt != null) return null
	if (token.expiresAt != null && token.expiresAt < Date.now()) return null
	void services.db.touchToken(token.id) // fire-and-forget audit stamp
	return { subject: `token:${token.id}`, capabilities: capabilitiesForToken(token.capability), scope: scopeForToken(token) }
}

function extractBearer(request: Request): string | null {
	const header = request.headers.get('authorization')
	if (!header?.startsWith('Bearer ')) return null
	const value = header.slice('Bearer '.length).trim()
	return value || null
}

function extractSharedToken(request: Request): string | null {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (queryToken) return queryToken
	const cookies = request.headers.get('cookie') ?? ''
	for (const part of cookies.split(';')) {
		const [k, v] = part.trim().split('=')
		if (k === READ_COOKIE && v) return v
	}
	return null
}

// ---- capability + scope assertions ----------------------------------------

export function has(principal: Principal, capability: Capability): boolean {
	return principal.capabilities.has(capability)
}

/** Can this principal see project-level metadata (name, etc.)? Run scope counts. */
export function canSeeProject(scope: Scope, projectId: number): boolean {
	return scope.kind === 'all' || scope.projectId === projectId
}

/** Can this principal browse *all* runs of a project? A run-scoped link cannot. */
export function canListRuns(scope: Scope, projectId: number): boolean {
	return scope.kind === 'all' || (scope.kind === 'project' && scope.projectId === projectId)
}

/** Can this principal see one specific run? */
export function canSeeRun(scope: Scope, projectId: number, runId: string): boolean {
	if (scope.kind === 'all') return true
	if (scope.kind === 'project') return scope.projectId === projectId
	return scope.projectId === projectId && scope.runId === runId
}

/** Can this principal read a screenshot R2 key (`<slug>/<runId>/...`)? */
export function canSeeScreenshot(scope: Scope, key: string): boolean {
	if (scope.kind === 'all') return true
	if (!key.startsWith(`${scope.slug}/`)) return false
	if (scope.kind === 'project') return true
	return key.startsWith(`${scope.slug}/${scope.runId}/`)
}

/**
 * Exchange a valid `?token=` for the `opice_read` cookie and redirect to the
 * token-stripped URL (so the secret leaves the address bar). Returns null when
 * there's no token to exchange or it doesn't resolve to a read principal.
 */
export async function readAccessRedirect(request: Request, services: Services): Promise<Response | null> {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (!queryToken) return null
	if (services.config.environment !== 'local') {
		const principal = await resolveShareToken(queryToken, services)
		if (!principal) return null
	}
	const next = new URL(url.toString())
	next.searchParams.delete('token')
	return new Response(null, {
		status: 302,
		headers: {
			location: next.toString(),
			'set-cookie': `${READ_COOKIE}=${queryToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
		},
	})
}
