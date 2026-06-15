/**
 * Authorization — TWO mechanisms, split by ROUTE (not by sniffing one endpoint).
 *
 * Everything is propustka. There are no opice-owned credentials.
 *
 *   1. OPERATOR — a human behind Cloudflare Access. The operator surface (`/rpc`, `/screenshots`,
 *      the dashboard SPA) is COVERED by Access, so the `Cf-Access-Jwt-Assertion` header is always
 *      injected; `resolveOperator` hands it to propustka `authenticate()` → an `AuthContext` whose
 *      `can()`/`scopedTo()` are local pure checks. Project key = the SLUG.
 *
 *   2. CAPABILITY — every non-operator caller (CI ingest, the agent read DSN, the stage self-test,
 *      and anonymous run-share visitors). A propustka capability token presented as `Bearer`
 *      (ingest/machine) or `?token=`/`opice_read` cookie (share links), redeemed by the Worker over
 *      the IAM binding (which does NOT traverse Access — that's why these live on PUBLIC paths:
 *      `/api/v1/*` ingest and `/s/*` read). The redeemed `Capability.can(action, resource)` is
 *      exact-match; the Worker supplies the resource from the REQUEST (slug in the ingest URL, the
 *      run/project id from the read params), so no grant enumeration is needed.
 *
 * Action taxonomy (mapped onto propustka roles admin=`*`, editor=`project.*`+`report.*`,
 * viewer=`project.read`+`report.read`, no roles.ts edit):
 *   - `project.read`  — see a project + its metadata/run-list (viewer+).
 *   - `report.read`   — read a run's scenarios/steps/screenshots (viewer+).
 *   - `project.write` — create projects, mint/revoke capabilities (editor+).
 *   - `report.write`  — write run data; the INGEST capability grants this on `project:<slug>` (editor+ to delegate).
 */

import type { AuthContext, AuthFailure, Capability } from '@propustka/client'
import type { Services } from './services'

export const READ_COOKIE = 'opice_read'

// ── Operator plane (Cloudflare Access + propustka) ──────────────────────────────

/** Resolve the operator from the forwarded Access JWT. AuthContext on success, else a typed failure. */
export function resolveOperator(request: Request, services: Services): Promise<AuthContext | AuthFailure> {
	return services.iam.authenticate(request)
}

/** May the operator see project `slug` (metadata + run list)? */
export function opCanReadProject(auth: AuthContext, slug: string): boolean {
	return auth.can('project.read', { type: 'project', value: slug })
}

/** May the operator read project `slug`'s run reports (runs/scenarios/steps/screenshots)? */
export function opCanReadReports(auth: AuthContext, slug: string): boolean {
	return auth.can('report.read', { type: 'project', value: slug })
}

/** May the operator create projects / mint+revoke capabilities (optionally scoped to `slug`)? */
export function opCanWriteProject(auth: AuthContext, slug?: string): boolean {
	return auth.can('project.write', slug ? { type: 'project', value: slug } : undefined)
}

/** May the operator browse EVERY project's runs (cross-project feed)? Global report.read only. */
export function opCanReadAll(auth: AuthContext): boolean {
	return auth.scopedTo('report.read', 'project') === null
}

// ── Machine plane (propustka SERVICE-TOKEN principals on /api/v1, behind Access) ──
//
// CI ingest + the agent read DSN are Cloudflare Access SERVICE TOKENS backed by propustka
// service principals (minted via iam.issueServiceToken). The Access edge validates the
// client-id/secret pair and injects the JWT, so they authenticate exactly like an operator —
// `authenticate()` → AuthContext — and are gated by `can()`, never redeemed as a capability.

/** Resolve the machine caller from the Access-injected service-token JWT. AuthContext or a typed failure. */
export function resolveMachine(request: Request, services: Services): Promise<AuthContext | AuthFailure> {
	return services.iam.authenticate(request)
}

/** May this machine principal WRITE run data to project `slug` (the ingest service token)? */
export function machineCanWriteReports(auth: AuthContext, slug: string): boolean {
	return auth.can('report.write', { type: 'project', value: slug })
}

/** May this machine principal READ project `slug`'s run reports (the agent read service token)? */
export function machineCanReadReports(auth: AuthContext, slug: string): boolean {
	return auth.can('report.read', { type: 'project', value: slug })
}

// ── Capability plane (propustka capability tokens — anonymous browser shares, /s/*) ──

/**
 * Redeem the read capability for the public `/s/*` share surface. An anonymous browser visitor
 * carries it as `?token=` / the `opice_read` cookie. (Machine readers are no longer here — they
 * are service-token principals on /api/v1; see the machine plane above.)
 */
export async function redeemReadCapability(request: Request, services: Services): Promise<Capability | null> {
	const secret = extractShareSecret(request)
	if (!secret) return null
	const cap = await services.iam.redeemCapability(request, secret)
	return cap.ok ? cap : null
}

/** May this capability read run `runId` (in project `slug`)? A run-share OR a project-read cap. */
export function capCanReadRun(cap: Capability, slug: string, runId: string): boolean {
	return cap.can('report.read', `run:${runId}`) || cap.can('report.read', `project:${slug}`)
}

/** May this capability read project `slug`'s metadata (name)? */
export function capCanReadProject(cap: Capability, slug: string): boolean {
	return cap.can('project.read', `project:${slug}`)
}

/** May this capability browse project `slug`'s full run list? Only a project-scoped read cap. */
export function capCanListRuns(cap: Capability, slug: string): boolean {
	return cap.can('report.read', `project:${slug}`)
}

/** May this capability read a screenshot R2 key (`<slug>/<runId>/...`)? */
export function capCanReadScreenshotKey(cap: Capability, key: string): boolean {
	const [slug = '', runId = ''] = key.split('/')
	return slug !== '' && runId !== '' && capCanReadRun(cap, slug, runId)
}

// ── Credential extraction ───────────────────────────────────────────────────────

function extractShareSecret(request: Request): string | null {
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
 * Exchange a valid `?token=` (a share-link capability) for the `opice_read` cookie and redirect to
 * the token-stripped URL (so the secret leaves the address bar, then rides every `/s/rpc` call).
 * Returns null when there's no token, or it doesn't redeem. Locally the gate is open, so any
 * `?token=` is accepted as-is. Runs only on the public `/s/*` share surface.
 */
export async function readAccessRedirect(request: Request, services: Services): Promise<Response | null> {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (!queryToken) return null
	if (services.config.environment !== 'local') {
		const cap = await services.iam.redeemCapability(request, queryToken)
		if (!cap.ok) return null
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
