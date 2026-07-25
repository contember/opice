/**
 * URL → route template.
 *
 * Raw URLs are useless for aggregation: `/api/invoices/8f3c…/lines` and
 * `/api/invoices/1b7a…/lines` are the same endpoint, and keeping them apart
 * would turn a scenario's footprint into a list of ids. So every path segment
 * that *looks* like an identifier collapses to `:id`, and the result is what
 * both the dashboard and the edge index key on.
 *
 * The heuristic is deliberately conservative — it would rather leave a real id
 * in place (a duplicate endpoint row) than collapse a meaningful segment (two
 * distinct endpoints silently merged into one). A repo whose ids don't fit the
 * shapes below can override the whole thing with `normalizeUrl` in its
 * `browser-footprint.ts`.
 *
 * Query VALUES are dropped unconditionally — they carry tokens, emails and
 * search terms, and a footprint is rendered on a dashboard. Only the parameter
 * names survive.
 */

/** A 8-4-4-4-12 UUID, with or without dashes. */
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
/** Crockford base32 ULID / KSUID-ish: 26+ chars of upper-case alphanumerics. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26,}$/
/** A long hex blob — a hash, an object id, a content digest. */
const HEX_RE = /^[0-9a-f]{12,}$/i
/** Pure digits — a numeric primary key. `v1`, `2024` in a path stay put (see below). */
const DIGITS_RE = /^\d+$/
/** base64url-ish opaque token: mixed case + digits, no separators, long. */
const OPAQUE_RE = /^[A-Za-z0-9_-]{16,}$/

/**
 * Is this path segment an identifier rather than a route name?
 *
 * `index` is the segment's position: the FIRST segment is never collapsed. A
 * leading numeric segment is far more likely to be a route (`/2024/archive`,
 * `/1/edit` under a locale-less app) than an id, and collapsing it would merge
 * whole sections of a site together.
 */
export function isIdSegment(segment: string, index: number): boolean {
	if (!segment) return false
	if (UUID_RE.test(segment)) return true
	if (ULID_RE.test(segment)) return true
	if (HEX_RE.test(segment)) return true
	// Positional guards below: an id in the first segment is indistinguishable
	// from a top-level route, so leave it alone.
	if (index === 0) return false
	if (DIGITS_RE.test(segment)) return true
	// An opaque token must actually MIX character classes — `unsubscribe_all` and
	// `admin-dashboard-v2` are route names, not ids, however long they are.
	if (OPAQUE_RE.test(segment) && /\d/.test(segment) && /[A-Za-z]/.test(segment) && !/[_-]/.test(segment)) {
		return /[A-Z]/.test(segment) && /[a-z]/.test(segment)
	}
	return false
}

export interface RouteTemplate {
	/** Path template; origin-qualified (`https://host/path`) when not same-origin. */
	route: string
	/** Sorted query parameter names. Undefined when the URL had no query. */
	params?: string[]
}

/**
 * Turn a request URL into a route template, relative to the app's own origin.
 * A same-origin URL keeps only its path; anything else keeps its origin too, so
 * a third-party API is visibly third-party on the dashboard.
 *
 * Returns null for URLs that carry no route at all (`data:`, `blob:`) — those
 * are noise in a footprint.
 */
export function toRouteTemplate(rawUrl: string, appOrigin?: string): RouteTemplate | null {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return null
	}
	if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return null
	const segments = url.pathname.split('/').filter(Boolean)
	const templated = segments.map((segment, i) => (isIdSegment(segment, i) ? ':id' : segment))
	const path = '/' + templated.join('/')
	const sameOrigin = appOrigin !== undefined && url.origin === appOrigin
	const route = sameOrigin ? path : `${url.origin}${path}`
	const params = [...new Set([...url.searchParams.keys()])].sort()
	return params.length > 0 ? { route, params } : { route }
}

/**
 * Resource types that count as API traffic — the requests worth recording one
 * by one. Everything else (scripts, styles, images, fonts) is either noise or
 * feeds the FILE side of the footprint instead; recording a dev server's
 * several-hundred ES module requests here would bury the handful of API calls
 * that actually describe what the scenario does.
 */
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'eventsource', 'websocket', 'document'])

export function isApiResourceType(resourceType: string): boolean {
	return API_RESOURCE_TYPES.has(resourceType)
}
