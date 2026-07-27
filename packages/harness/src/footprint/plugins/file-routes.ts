/**
 * File-routed backends: an API request → the route file that serves it.
 *
 * The demonstration that "observation → dependency" generalizes past GraphQL.
 * `POST /api/invoices/:id` is served by `app/routes/api.invoices.$id.ts` in
 * Remix / React Router and by `pages/api/invoices/[id].ts` in Next — a fact the
 * repo knows and the browser cannot. Without it that request produces an
 * `endpoint` edge, which no file change ever matches; with it, editing the route
 * file selects the scenarios that call it.
 *
 * Deliberately built on the file *listing*, not on a naming heuristic: it only
 * ever claims a path that actually exists in the repo, so a wrong guess produces
 * no edge rather than a phantom one.
 */

import type { Dependency, FootprintPlugin, RequestObservation } from './types.js'
import { listFiles } from './walk.js'

export interface FileRoutesOptions {
	/** Directory holding the route files, repo-relative. */
	dir: string
	/** Route-file extensions, in preference order. */
	extensions?: string[]
	/**
	 * Naming style. `flat` is Remix/React-Router v7 (`api.invoices.$id.ts`),
	 * `nested` is Next-style directories (`api/invoices/[id].ts`).
	 */
	style?: 'flat' | 'nested'
	/** Only consider requests whose route starts with one of these prefixes. */
	prefixes?: string[]
}

export function fileRoutes(options: FileRoutesOptions): FootprintPlugin {
	const extensions = options.extensions ?? ['.ts', '.tsx', '.js', '.jsx']
	const style = options.style ?? 'flat'
	const prefixes = options.prefixes ?? ['/']
	return {
		name: 'file-routes',
		dimensions: ['files'],
		bind: () => {
			// One listing per scenario, closed over — the routes directory does not
			// change under a running test, and statting per request would be silly.
			const existing = listFiles(options.dir)
			return {
				resolve: (request) => resolveRoute(request, { existing, dir: options.dir, extensions, style, prefixes }),
			}
		},
	}
}

interface Resolution {
	existing: Set<string>
	dir: string
	extensions: string[]
	style: 'flat' | 'nested'
	prefixes: string[]
}

function resolveRoute(request: RequestObservation, config: Resolution): Dependency[] {
	// Only real API traffic: a document navigation is the SPA shell, and the
	// module and coverage collectors already speak for the client side.
	if (request.resourceType === 'document' || request.resourceType === 'websocket') return []
	// An origin-qualified route belongs to a third party (analytics, a CDN), and
	// this repo does not serve it.
	if (!request.route.startsWith('/')) return []
	if (!config.prefixes.some((prefix) => request.route.startsWith(prefix))) return []
	// `:id` is our own template marker; the route file's own placeholder replaces it.
	const segments = request.route.split('/').filter(Boolean)
	if (segments.length === 0) return []
	const candidates = config.style === 'flat' ? flatNames(segments) : nestedNames(segments)
	for (const candidate of candidates) {
		for (const extension of config.extensions) {
			const file = `${config.dir}/${candidate}${extension}`
			if (config.existing.has(file)) return [{ kind: 'file', path: file }]
		}
	}
	return []
}

/** `['api', 'invoices', ':id']` → `api.invoices.$id`, plus an `_index` form. */
function flatNames(segments: readonly string[]): string[] {
	const joined = segments.map((segment) => (segment === ':id' ? '$id' : segment)).join('.')
	return [joined, `${joined}._index`]
}

/** `['api', 'invoices', ':id']` → `api/invoices/[id]`, plus a directory `index` form. */
function nestedNames(segments: readonly string[]): string[] {
	const joined = segments.map((segment) => (segment === ':id' ? '[id]' : segment)).join('/')
	return [joined, `${joined}/index`]
}

