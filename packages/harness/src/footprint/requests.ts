/**
 * The request recorder — one scenario's API request stream.
 *
 * The half of a footprint that comes off the wire: every API request the page
 * made, collapsed to a route template, attributed to the step that started it,
 * and — where the body carries a GraphQL document — the operations and the models
 * behind them. It owns the bookkeeping that goes with that: the pending map a
 * response later completes, and the set of origins that count as "the app".
 *
 * It observes only, and the collector's two invariants (see `collector.ts`) hold
 * here as much as anywhere — the no-leak one is mostly about this file. Request
 * bodies are read ONLY to recover operation and field names; nothing else derived
 * from one is ever stored, and no header, cookie, variable or query value is read
 * at all.
 */

import type { BrowserContext, Page, Request } from 'playwright'
import type { FootprintConfig } from './config.js'
import { MAX_REQUESTS, type DegradationLedger } from './degradation.js'
import { deriveModels, extractQueries, looksLikeGraphql, parseOperations, toFootprintOperation, type ParsedOperation } from './graphql.js'
import type { PluginChain } from './plugins/chain.js'
import type { GraphqlConventions } from './plugins/types.js'
import type { FootprintEndpoint, FootprintModel, FootprintOperation, FootprintRequest } from './types.js'
import { isApiResourceType, toRouteTemplate } from './url.js'

// Another cap on what one scenario may record. `MAX_REQUESTS`/`MAX_FILES` live
// in `degradation.ts`, beside the warning that reports them; this one is not
// reported by count, so it needs no signal of its own.
/** Bodies larger than this aren't scanned for GraphQL — a file upload isn't a query. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** What the recorder needs of the scenario itself — everything else is a collaborator. */
export interface RecorderOptions {
	/** The scenario's base URL — its origin is what counts as "the app". */
	baseUrl?: string
	config: FootprintConfig
}

interface PendingRequest {
	record: FootprintRequest
	startedAt: number
}

export class RequestRecorder {
	private readonly recorded: FootprintRequest[] = []
	private readonly pending = new Map<Request, PendingRequest>()
	private readonly origins: Set<string>
	private activeStep: number | null = null
	/** Parsed operations per recorded request, for the plugin `resolve` pass. Never stored. */
	private readonly parsedByRequest = new Map<FootprintRequest, ParsedOperation[]>()

	constructor(
		private readonly options: RecorderOptions,
		/** Plugins bound to this scenario. See `plugins/types.ts`. */
		private readonly plugins: PluginChain,
		/** Parser conventions the plugins contribute, unioned. */
		private readonly conventions: Required<GraphqlConventions>,
		/** The collector's ledger — one per scenario, shared. See `degradation.ts`. */
		private readonly degradation: DegradationLedger,
	) {
		this.origins = new Set<string>()
		const base = safeOrigin(options.baseUrl)
		if (base) this.origins.add(base)
		for (const origin of options.config.appOrigins ?? []) {
			const normalized = safeOrigin(origin)
			if (normalized) this.origins.add(normalized)
		}
	}

	/**
	 * Listen for what completes a record. The `request` event stays with the
	 * collector, which dispatches script and stylesheet requests to the module
	 * collector and everything else to {@link record}.
	 */
	attach(context: BrowserContext): void {
		context.on('response', this.onResponse)
		context.on('requestfailed', this.onRequestFailed)
	}

	/** Drop the listeners {@link attach} added. The collector calls this exactly once. */
	detach(context: BrowserContext): void {
		context.off('response', this.onResponse)
		context.off('requestfailed', this.onRequestFailed)
	}

	/** Record every WebSocket a page opens. Safe to call more than once per page. */
	watchWebSockets(page: Page): void {
		page.on('websocket', (ws) => {
			try {
				const template = this.templateFor(ws.url())
				if (!template) return
				this.push({
					step: this.activeStep,
					method: 'WS',
					route: template.route,
					...(template.params ? { params: template.params } : {}),
					status: null,
					resourceType: 'websocket',
					durationMs: null,
				})
			} catch {
				// An observer must never break the page it observes.
			}
		})
	}

	/**
	 * Point subsequent traffic at a step. Requests are attributed at *start*, so
	 * a response that arrives after the step ended still belongs to the step that
	 * triggered it. The last step stays active until the next one begins, which
	 * means trailing async work lands on the step that caused it rather than
	 * being dropped.
	 */
	setActiveStep(sequence: number | null): void {
		this.activeStep = sequence
	}

	/** Record one request. Scripts and stylesheets never reach here — see {@link attach}. */
	record(request: Request): void {
		const url = request.url()
		const resourceType = request.resourceType()
		if (!isApiResourceType(resourceType)) return
		const template = this.templateFor(url)
		if (!template) return
		const record: FootprintRequest = {
			step: this.activeStep,
			method: request.method(),
			route: template.route,
			...(template.params ? { params: template.params } : {}),
			status: null,
			resourceType,
			durationMs: null,
		}
		const parsed: ParsedOperation[] = []
		const operations = this.parseGraphql(request, url, parsed)
		if (operations.length > 0) record.operations = operations
		if (!this.push(record)) return
		this.pending.set(request, { record, startedAt: Date.now() })
		// Kept beside the record, not inside it: the selection tree and argument key
		// paths are what a plugin's `resolve` reads, and they are deliberately never
		// stored in the footprint (500 nodes times 2000 requests).
		if (parsed.length > 0) this.parsedByRequest.set(record, parsed)
	}

	/** The stream itself, live — the footprint takes this array as it stands. */
	get requests(): FootprintRequest[] {
		return this.recorded
	}

	/** What a request parsed to, for the plugin `resolve` pass. Absent when it carried no GraphQL. */
	parsedFor(request: FootprintRequest): readonly ParsedOperation[] | undefined {
		return this.parsedByRequest.get(request)
	}

	isAppOrigin(url: string): boolean {
		const origin = safeOrigin(url)
		// With no known base URL, treat every origin as the app's: a footprint with
		// its origins mislabelled is better than an empty one.
		return origin !== null && (this.origins.size === 0 || this.origins.has(origin))
	}

	private parseGraphql(request: Request, url: string, collected: ParsedOperation[]): FootprintOperation[] {
		let pathname: string
		try {
			pathname = new URL(url).pathname
		} catch {
			return []
		}
		let body: string | undefined
		try {
			// `postData()` is the request the app sent; it is read ONLY to recover
			// operation and field names below. Nothing derived from it is stored.
			body = request.postData() ?? undefined
		} catch {
			return []
		}
		// The content type is half the detection: a raw `application/graphql` body
		// carries neither a /graphql path nor a JSON "query" key, so without it such
		// a request records no operations at all.
		const contentType = request.headers()['content-type']
		if (body && body.length > MAX_BODY_BYTES) {
			// Too large to scan. Whether that COSTS us anything depends on what it
			// was: only the path and the content type can say, since the body is the
			// thing we are declining to read. A GraphQL endpoint means a document we
			// lost — the same shape as a persisted query, and the models go partial.
			// Anything else is a file upload, and counting it would mark the model
			// dimension partial for a scenario that never lost any GraphQL at all,
			// freezing its model edges for good.
			if (looksLikeGraphql(pathname, undefined, contentType)) this.degradation.note('oversizedBodies')
			return []
		}
		if (!looksLikeGraphql(pathname, body, contentType)) return []
		const extracted = extractQueries(body, contentType)
		this.degradation.note('persistedQueries', extracted.persisted)
		// A GraphQL request this recognises but whose document never reached us —
		// a GET carrying `?query=…`, where Playwright reports no post data. It
		// yields neither operations nor persisted-query evidence, so without this
		// the models would silently read as "none", and an empty authoritative set
		// would replace whatever a fuller run had indexed. The endpoint itself was
		// observed perfectly well; only the models are unknown.
		// A CORS preflight carries no body by definition — it is not a GraphQL
		// document that failed to reach us, it is not a document at all. Counting it
		// marked models partial for every cross-origin API, which excluded EVERY
		// model edge even when the POST that followed parsed perfectly.
		const method = request.method().toUpperCase()
		const carriesBody = method !== 'OPTIONS' && method !== 'HEAD'
		if (carriesBody && extracted.documents.length === 0 && extracted.persisted === 0) {
			this.degradation.note('unreadableOperations')
		}
		const operations: FootprintOperation[] = []
		for (const document of extracted.documents) {
			const parseOptions = {
				...(document.operationName ? { operationName: document.operationName } : {}),
				// The repo's own `transparentFields` replaces the plugins' set; absent
				// it, the plugins' union applies (Contember's `transaction` among them).
				transparentFields: this.options.config.transparentFields ?? this.conventions.transparentFields,
				ignoredRootFields: this.conventions.ignoredRootFields,
			}
			for (const parsed of parseOperations(document.query, parseOptions)) {
				if (parsed.truncated) this.degradation.note('truncatedSelections')
				collected.push(parsed)
				let mapped: FootprintModel[] | null | undefined
				try {
					mapped = this.options.config.mapOperation?.(parsed)
				} catch (err) {
					// A throwing mapper costs its operation's models, nothing more. Left
					// uncaught it escapes to `onRequest`'s catch, which drops the WHOLE
					// request — so a bug in user configuration would quietly erase the
					// endpoint too, and the footprint would still call itself complete.
					this.degradation.note('mapperFailures')
					this.degradation.warn(`mapOperation threw (falling back to the built-in model derivation): ${message(err)}`)
				}
				operations.push(toFootprintOperation(parsed, mapped ?? this.deriveModels(parsed)))
			}
		}
		return operations
	}

	/** The built-in verb+Entity derivation, with the plugin rule chain ahead of it. */
	private deriveModels(operation: ParsedOperation): FootprintModel[] {
		return deriveModels(operation, {
			readVerbs: this.conventions.readVerbs,
			writeVerbs: this.conventions.writeVerbs,
			field: (node) => this.plugins.model(node, operation),
		})
	}

	private readonly onResponse = (response: { request(): Request; status(): number }): void => {
		try {
			const entry = this.pending.get(response.request())
			if (!entry) return
			entry.record.status = response.status()
			entry.record.durationMs = Date.now() - entry.startedAt
			this.pending.delete(response.request())
		} catch {
			// ignore
		}
	}

	private readonly onRequestFailed = (request: Request): void => {
		const entry = this.pending.get(request)
		if (!entry) return
		entry.record.durationMs = Date.now() - entry.startedAt
		this.pending.delete(request)
	}

	private push(record: FootprintRequest): boolean {
		if (this.recorded.length >= MAX_REQUESTS) {
			this.degradation.note('truncatedRequests')
			return false
		}
		this.recorded.push(record)
		return true
	}

	private templateFor(url: string): { route: string; params?: string[] } | null {
		// The repo's own hook first — it is the most specific thing in the tree —
		// then plugins, then the built-in templating.
		const override = this.options.config.normalizeUrl
		if (override) {
			try {
				const custom = override(url)
				if (custom === null) return null
				if (custom !== undefined) return splitCustomRoute(custom)
			} catch (err) {
				this.degradation.warn(`normalizeUrl threw (falling back to the built-in templating): ${message(err)}`)
			}
		}
		const fromPlugin = this.plugins.route(url)
		if (fromPlugin === null) return null
		if (fromPlugin !== undefined) return splitCustomRoute(fromPlugin)
		const appOrigin = this.isAppOrigin(url) ? safeOrigin(url) ?? undefined : undefined
		return toRouteTemplate(url, appOrigin, this.redactSegment)
	}

	/**
	 * The repo's `redactSegment` OR any plugin's. Redaction can only ever be
	 * ADDED — returning false never keeps a segment the built-ins would have
	 * collapsed — so this is a disjunction and order cannot matter.
	 */
	private readonly redactSegment = (segment: string, context: { index: number; segments: readonly string[] }): boolean => {
		// A throw here is deliberately NOT caught: `toRouteTemplate` handles it by
		// redacting, which is the side that cannot leak. Swallowing it and carrying
		// on would keep a segment the caller asked us to judge and couldn't.
		const own = this.options.config.redactSegment
		if (own && own(segment, context) === true) return true
		return this.plugins.segment(segment, context.index, context.segments)
	}
}

/** Deduplicate requests into endpoint rows: one per route, methods merged. */
export function aggregateEndpoints(requests: readonly FootprintRequest[]): FootprintEndpoint[] {
	const byRoute = new Map<string, { methods: Set<string>; count: number }>()
	for (const request of requests) {
		const entry = byRoute.get(request.route) ?? { methods: new Set<string>(), count: 0 }
		entry.methods.add(request.method)
		entry.count++
		byRoute.set(request.route, entry)
	}
	return [...byRoute]
		.map(([route, entry]) => ({ route, methods: [...entry.methods].sort(), count: entry.count }))
		.sort((a, b) => a.route.localeCompare(b.route))
}

/** Union of every operation's models; a model written anywhere counts as written. */
export function aggregateModels(requests: readonly FootprintRequest[]): FootprintModel[] {
	const byName = new Map<string, boolean>()
	for (const request of requests) {
		for (const operation of request.operations ?? []) {
			for (const model of operation.models) {
				byName.set(model.name, (byName.get(model.name) ?? false) || model.write)
			}
		}
	}
	return [...byName]
		.map(([name, write]) => ({ name, write }))
		.sort((a, b) => a.name.localeCompare(b.name))
}

function safeOrigin(url: string | undefined): string | null {
	if (!url) return null
	try {
		return new URL(url).origin
	} catch {
		return null
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

/**
 * Split a custom `normalizeUrl` result into a route and its query parameter NAMES.
 *
 * `normalizeUrl` replaces the path templating — that is its job, and what it
 * returns is taken as the route. It does not, however, get to opt out of the one
 * rule that holds everywhere: query values never enter a footprint. They carry
 * tokens, emails and search terms, and the footprint is uploaded and rendered on
 * a dashboard. An override written to fix one path (`url.replace(/\/orders\/\d+/, …)`)
 * has no reason to think about the `?token=` still hanging off the end, so this
 * strips it for them. Parameter names survive, as they do for built-in templating.
 *
 * The fragment goes too: it never reaches a server, and client routers put real
 * ids in it.
 */
export function splitCustomRoute(custom: string): { route: string; params?: string[] } {
	const withoutFragment = custom.split('#')[0] ?? ''
	const queryStart = withoutFragment.indexOf('?')
	if (queryStart === -1) return { route: withoutFragment }
	const route = withoutFragment.slice(0, queryStart)
	const names = [...new Set([...new URLSearchParams(withoutFragment.slice(queryStart + 1)).keys()])].sort()
	return names.length > 0 ? { route, params: names } : { route }
}
