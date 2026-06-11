/**
 * Request authorization — THREE credential planes, one resolver.
 *
 * Opice serves three kinds of caller, and `resolveCaller(request)` normalizes any of them into a
 * single `Caller` the handlers gate on:
 *
 *   1. OPERATOR — a human at the dashboard. Cloudflare Access authenticates at the edge (the
 *      `Cf-Access-Jwt-Assertion` header); the propustka IAM Worker resolves the principal + its
 *      permissions; `can()`/`scopedTo()` are local pure checks. Replaces the old BetterAuth
 *      session + role model.
 *   2. MACHINE — CI reporting (ingest, `write`), the authoring agent's read DSN (`read`), the
 *      stage self-test (`read`). An app-local hashed token row presented as `Authorization:
 *      Bearer` (or, read-only, via the share cookie). Resolved WITHOUT Access or propustka — this
 *      is opice's data plane, the Sentry-DSN equivalent: machine traffic must not depend on the
 *      human-auth edge. Lives in the `tokens` table (migration 0003).
 *   3. SHARE — an anonymous run-share visitor. A propustka *capability token* presented via
 *      `?token=` / the `opice_read` cookie, redeemed to a `Capability` whose `can(action,
 *      resource)` is exact-match. Replaces the old run-scoped read token rows.
 *
 * PROJECT IDENTITY: opice's IAM-facing project key is the SLUG. Operator checks read
 * `can('project.read', { project: slug })`; the integer `projects.id` stays app-internal.
 *
 * Action taxonomy (mapped onto propustka's code-defined roles admin=`*`, editor=`project.*`,
 * viewer=`project.read`, WITHOUT editing roles.ts):
 *   - `project.read`   — read a project + its runs/scenarios/steps/screenshots (viewer+).
 *   - `project.write`  — create projects, mint/revoke run-share links (editor+).
 *   - `token.manage`   — the data-plane token inventory (admin only; editor's `project.*` misses it).
 */

import type { AuthContext, Capability } from '@propustka/client'
import type { Services } from './services'
import type { Project, Token } from './types'

export const READ_COOKIE = 'opice_read'

// ── Caller (the normalized result of resolveCaller) ────────────────────────────

/** A machine token's data scope: every project (global read), or exactly one project. */
export type MachineScope =
	| { kind: 'all' }
	| { kind: 'project'; projectId: number; slug: string }

export type Caller =
	/** A human operator resolved through Cloudflare Access + propustka. */
	| { kind: 'operator'; auth: AuthContext }
	/** An app-local machine token (CI ingest / agent read / self-test). `read` or `write`. */
	| { kind: 'machine'; capability: 'read' | 'write'; scope: MachineScope; subject: string }
	/** An anonymous run-share visitor holding a redeemed propustka capability. */
	| { kind: 'share'; cap: Capability; subject: string }

export type CallerResult =
	| { ok: true; caller: Caller }
	| { ok: false; status: 401 | 403 | 404 }

// ── Token hashing & generation (data-plane machine tokens) ─────────────────────

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

// ── Data-plane (machine) token resolution ──────────────────────────────────────

function machineScope(token: Token): MachineScope {
	if (token.projectId == null || token.projectSlug == null) return { kind: 'all' }
	return { kind: 'project', projectId: token.projectId, slug: token.projectSlug }
}

function tokenLive(token: Token): boolean {
	if (token.revokedAt != null) return false
	if (token.expiresAt != null && token.expiresAt < Date.now()) return false
	// A run-scoped row is a LEGACY share (pre-migration-0007). Shares are propustka capability
	// tokens now; an old run-scoped read row must NOT resolve here (it would widen to the whole
	// project). Treat it as dead — re-share from the run page.
	if (token.runId != null) return false
	return true
}

/**
 * Resolve an `Authorization: Bearer` secret to a machine caller. Only `read`/`write` tokens
 * exist on the data plane now — a legacy `admin` token row resolves to nothing (operator admin
 * is Access + `token.manage`, never a bearer secret).
 */
async function resolveMachineToken(secret: string, services: Services): Promise<Caller | null> {
	const token = await services.db.getTokenByHash(await hashToken(secret))
	if (!token || !tokenLive(token) || token.capability === 'admin') return null
	void services.db.touchToken(token.id) // fire-and-forget audit stamp
	return { kind: 'machine', capability: token.capability, scope: machineScope(token), subject: `token:${token.id}` }
}

/**
 * Resolve a share-cookie / `?token=` secret. Read-only BY CONSTRUCTION: an app-local *read*
 * token (the self-test global read, an agent read DSN used in a browser) resolves to a machine
 * read caller; anything else is tried as a propustka capability (a run-share link). A `write`
 * token presented this way never matches the read path and never redeems as a capability, so the
 * "share links are read-only" invariant holds.
 */
async function resolveShareSecret(secret: string, request: Request, services: Services): Promise<Caller | null> {
	const token = await services.db.getTokenByHash(await hashToken(secret))
	if (token && tokenLive(token) && token.capability === 'read') {
		void services.db.touchToken(token.id)
		return { kind: 'machine', capability: 'read', scope: machineScope(token), subject: `token:${token.id}` }
	}
	const cap = await services.iam.redeemCapability(request, secret)
	if (cap.ok) return { kind: 'share', cap, subject: 'capability' }
	return null
}

// ── The unified resolver ────────────────────────────────────────────────────────

/**
 * Resolve any caller for the RPC + screenshot surfaces. Order matters:
 *   1. an explicit `Authorization: Bearer` is a machine claim — resolve it or 401, never
 *      fall through (keeps ingest resolving to its real project);
 *   2. a forwarded Access JWT is a real operator (off-local) — resolve through propustka;
 *   3. an explicit `?token=` / share cookie is a share/read claim — resolve or 401;
 *   4. otherwise fall back to the operator plane: locally the persona-backed fake opens the gate
 *      (default-admin / dev-persona cookie); off-local with no JWT this is `missing_token` (401).
 *
 * Putting the explicit machine/share planes ahead of the operator FALLBACK is what lets a local
 * `?token=` share or a `Bearer` reporter resolve to the right plane even though the local fake
 * would otherwise resolve everyone to the default admin.
 */
export async function resolveCaller(request: Request, services: Services): Promise<CallerResult> {
	const bearer = extractBearer(request)
	if (bearer) {
		const machine = await resolveMachineToken(bearer, services)
		return machine ? { ok: true, caller: machine } : { ok: false, status: 401 }
	}

	if (request.headers.has('cf-access-jwt-assertion')) {
		const auth = await services.iam.authenticate(request)
		if (auth.ok) return { ok: true, caller: { kind: 'operator', auth } }
		// A forwarded-but-unresolved JWT (unknown/disabled principal): fall through to a share
		// token if any, else surface this failure from the fallback below.
	}

	const shared = extractSharedToken(request)
	if (shared) {
		const caller = await resolveShareSecret(shared, request, services)
		return caller ? { ok: true, caller } : { ok: false, status: 401 }
	}

	const auth = await services.iam.authenticate(request)
	if (auth.ok) return { ok: true, caller: { kind: 'operator', auth } }
	return { ok: false, status: auth.status }
}

/**
 * Ingest's own resolver: a single project-scoped `write` machine token → its project. Ingest is
 * pure data plane — never an operator or a share — so it does NOT go through `resolveCaller`.
 */
export async function resolveIngestProject(request: Request, services: Services): Promise<Project | null> {
	const bearer = extractBearer(request)
	if (!bearer) return null
	const caller = await resolveMachineToken(bearer, services)
	if (!caller || caller.kind !== 'machine' || caller.capability !== 'write' || caller.scope.kind !== 'project') {
		return null
	}
	const project = await services.db.getProjectBySlug(caller.scope.slug)
	return project && project.id === caller.scope.projectId ? project : null
}

// ── Capability + scope gates (caller-aware) ─────────────────────────────────────

/** May this caller read project `slug` and its runs? (operator scope / machine scope / share.) */
export function canSeeProject(caller: Caller, slug: string): boolean {
	switch (caller.kind) {
		case 'operator': return caller.auth.can('project.read', { project: slug })
		case 'machine': return caller.capability === 'read' && (caller.scope.kind === 'all' || caller.scope.slug === slug)
		case 'share': return caller.cap.can('project.read', `project:${slug}`)
	}
}

/** May this caller browse EVERY project's runs (the cross-project feed)? Global readers only. */
export function canSeeAllProjects(caller: Caller): boolean {
	switch (caller.kind) {
		case 'operator': return caller.auth.scopedTo('project.read') === null
		case 'machine': return caller.capability === 'read' && caller.scope.kind === 'all'
		case 'share': return false
	}
}

/** May this caller browse the FULL run list of project `slug`? A share link (one run) cannot. */
export function canListRuns(caller: Caller, slug: string): boolean {
	switch (caller.kind) {
		case 'operator': return caller.auth.can('project.read', { project: slug })
		case 'machine': return caller.capability === 'read' && (caller.scope.kind === 'all' || caller.scope.slug === slug)
		case 'share': return false
	}
}

/** May this caller see one specific run (in project `slug`)? */
export function canSeeRun(caller: Caller, slug: string, runId: string): boolean {
	switch (caller.kind) {
		case 'operator': return caller.auth.can('project.read', { project: slug })
		case 'machine': return caller.capability === 'read' && (caller.scope.kind === 'all' || caller.scope.slug === slug)
		case 'share': return caller.cap.can('project.read', `run:${runId}`)
	}
}

/** May this caller read a screenshot R2 key (`<slug>/<runId>/...`)? */
export function canSeeScreenshotKey(caller: Caller, key: string): boolean {
	const [slug = '', runId = ''] = key.split('/')
	switch (caller.kind) {
		case 'operator': return slug !== '' && caller.auth.can('project.read', { project: slug })
		case 'machine': return caller.capability === 'read' && (caller.scope.kind === 'all' || (slug !== '' && caller.scope.slug === slug))
		case 'share': return runId !== '' && caller.cap.can('project.read', `run:${runId}`)
	}
}

/** May this caller create projects / mint+revoke share links for `slug`? Operators only. */
export function canProjectWrite(caller: Caller, slug?: string): boolean {
	if (caller.kind !== 'operator') return false
	return caller.auth.can('project.write', slug ? { project: slug } : undefined)
}

/** May this caller manage the data-plane token inventory? The admin surface — operators only. */
export function canTokenManage(caller: Caller): boolean {
	return caller.kind === 'operator' && caller.auth.can('token.manage')
}

/** The operator `AuthContext`, or null — for `audit()` and capability issue/revoke (operator ops). */
export function operatorOf(caller: Caller): AuthContext | null {
	return caller.kind === 'operator' ? caller.auth : null
}

/** A stable subject string for `created_by` / logs. */
export function subjectOf(caller: Caller): string {
	switch (caller.kind) {
		case 'operator': return caller.auth.principal.id
		case 'machine': return caller.subject
		case 'share': return caller.subject
	}
}

// ── Credential extraction ───────────────────────────────────────────────────────

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

/**
 * Exchange a valid `?token=` for the `opice_read` cookie and redirect to the token-stripped URL
 * (so the secret leaves the address bar). Returns null when there's no token, or it doesn't
 * resolve to a read caller. Locally the gate is open, so any `?token=` is accepted as-is.
 */
export async function readAccessRedirect(request: Request, services: Services): Promise<Response | null> {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (!queryToken) return null
	if (services.config.environment !== 'local') {
		const caller = await resolveShareSecret(queryToken, request, services)
		if (!caller) return null
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
