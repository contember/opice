/**
 * The footprint collector — one per scenario browser context.
 *
 * It attaches to the context the moment it's created (before the first
 * navigation, so nothing is missed) and produces a {@link ScenarioFootprint}
 * when the scenario ends. Everything it does is passive observation: request
 * events, a V8 coverage session, and a DevTools-hook binding. It never
 * intercepts, rewrites or blocks a request — an observer that can change what
 * the app does is no longer measuring the app.
 *
 * Two invariants hold throughout:
 *
 *  - **It cannot fail a test.** Every entry point swallows its own errors. A
 *    footprint is evidence, like a screenshot; a broken one is a gap on a
 *    dashboard, not a red build.
 *  - **It cannot leak.** Request and response *bodies* are read only to parse
 *    GraphQL field names out of them, and nothing derived from a body other than
 *    operation/field names is ever stored. No headers, no cookies, no variables,
 *    no query values.
 */

import type { BrowserContext, Page, Request } from 'playwright'
import { isIgnored, type FootprintConfig, type FootprintMode } from './config.js'
import { COMPONENT_BINDING, COMPONENT_SCRIPT } from './components.js'
import { collectJsCoverage, startJsCoverage } from './coverage.js'
import { deriveModels, extractQueries, looksLikeGraphql, parseOperations, toFootprintOperation } from './graphql.js'
import { moduleUrlToSourcePath } from './modules.js'
import type {
	FootprintCollectorKind,
	FootprintEndpoint,
	FootprintFile,
	FootprintModel,
	FootprintOperation,
	FootprintRequest,
	ScenarioFootprint,
} from './types.js'
import { isApiResourceType, toRouteTemplate } from './url.js'

/**
 * Caps on what one scenario may record. A runaway polling loop or an app that
 * lazy-loads a thousand modules must not turn a footprint into a multi-megabyte
 * blob. Hitting a cap is always reported as a warning — a silently truncated
 * footprint would read as "the scenario touches this much", which would be a lie.
 */
const MAX_REQUESTS = 2000
const MAX_FILES = 5000
/** Bodies larger than this aren't scanned for GraphQL — a file upload isn't a query. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface CollectorOptions {
	scenario: string
	testFile?: string
	/** The scenario's base URL — its origin is what counts as "the app". */
	baseUrl?: string
	mode: FootprintMode
	config: FootprintConfig
}

interface PendingRequest {
	record: FootprintRequest
	startedAt: number
}

export class FootprintCollector {
	private readonly requests: FootprintRequest[] = []
	private readonly pending = new Map<Request, PendingRequest>()
	/** path → how it was seen. Coverage results are merged over these at finish. */
	private readonly modules = new Map<string, FootprintFile>()
	private readonly components = new Set<string>()
	private readonly warnings = new Set<string>()
	private readonly origins: Set<string>
	private readonly collectors = new Set<FootprintCollectorKind>()
	private activeStep: number | null = null
	private coverageStarted = false
	private truncatedRequests = 0
	private truncatedFiles = 0
	private persistedQueries = 0
	private disposed = false

	private constructor(
		private readonly context: BrowserContext,
		private readonly options: CollectorOptions,
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
	 * Attach a collector to a freshly created context, before its first
	 * navigation. Returns null when collection is off — the caller then pays
	 * nothing at all, not even a no-op listener.
	 */
	static async attach(context: BrowserContext, page: Page, options: CollectorOptions): Promise<FootprintCollector | null> {
		if (options.mode === 'off') return null
		const collector = new FootprintCollector(context, options)
		try {
			await collector.start(page)
		} catch (err) {
			console.warn(`[opice] footprint collection failed to start (ignored): ${message(err)}`)
			return null
		}
		return collector
	}

	private async start(page: Page): Promise<void> {
		this.context.on('request', this.onRequest)
		this.context.on('response', this.onResponse)
		this.context.on('requestfailed', this.onRequestFailed)
		this.collectors.add('network')
		this.collectors.add('graphql')
		this.collectors.add('modules')
		page.on('websocket', (ws) => {
			const template = this.templateFor(ws.url())
			if (!template) return
			this.push({ step: this.activeStep, method: 'WS', route: template.route, ...(template.params ? { params: template.params } : {}), status: null, resourceType: 'websocket', durationMs: null })
		})
		if (this.options.mode !== 'full') return
		// Component names: the binding must exist before the init script runs, or
		// the page's first flush lands on an undefined function.
		try {
			await this.context.exposeBinding(COMPONENT_BINDING, (_source, names: unknown) => {
				if (!Array.isArray(names)) return
				for (const name of names) {
					if (typeof name === 'string' && name) this.components.add(name)
				}
			})
			await this.context.addInitScript(COMPONENT_SCRIPT)
			this.collectors.add('components')
		} catch (err) {
			this.warnings.add(`component collection unavailable: ${message(err)}`)
		}
		if (await startJsCoverage(page)) {
			this.coverageStarted = true
			this.collectors.add('coverage')
		} else {
			this.warnings.add('V8 JS coverage is unavailable in this browser — file footprint falls back to loaded modules.')
		}
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

	private readonly onRequest = (request: Request): void => {
		try {
			this.record(request)
		} catch {
			// An observer must never break the page it observes.
		}
	}

	private record(request: Request): void {
		const url = request.url()
		const resourceType = request.resourceType()
		if (resourceType === 'script' || resourceType === 'stylesheet') {
			this.recordModule(url)
			return
		}
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
		const operations = this.parseGraphql(request, url)
		if (operations.length > 0) record.operations = operations
		if (this.push(record)) this.pending.set(request, { record, startedAt: Date.now() })
	}

	/** A dev server's module request doubles as the identity of a source file. */
	private recordModule(url: string): void {
		if (!this.isAppOrigin(url)) return
		const mapped = moduleUrlToSourcePath(url, this.options.config.sourceRoot)
		if (mapped.bundled) {
			this.warnings.add(
				'the app under test is serving bundled assets — file-level footprint needs a dev server or source maps.',
			)
			return
		}
		if (!mapped.path || isIgnored(mapped.path, this.options.config.ignore)) return
		if (this.modules.size >= MAX_FILES) {
			this.truncatedFiles++
			return
		}
		if (!this.modules.has(mapped.path)) this.modules.set(mapped.path, { path: mapped.path, source: 'module' })
	}

	private parseGraphql(request: Request, url: string): FootprintOperation[] {
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
		if (body && body.length > MAX_BODY_BYTES) return []
		if (!looksLikeGraphql(pathname, body)) return []
		const extracted = extractQueries(body, request.headers()['content-type'])
		this.persistedQueries += extracted.persisted
		const operations: FootprintOperation[] = []
		for (const document of extracted.documents) {
			const parseOptions = {
				...(document.operationName ? { operationName: document.operationName } : {}),
				...(this.options.config.transparentFields ? { transparentFields: this.options.config.transparentFields } : {}),
			}
			for (const parsed of parseOperations(document.query, parseOptions)) {
				const mapped = this.options.config.mapOperation?.(parsed)
				operations.push(toFootprintOperation(parsed, mapped ?? deriveModels(parsed)))
			}
		}
		return operations
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
		if (this.requests.length >= MAX_REQUESTS) {
			this.truncatedRequests++
			return false
		}
		this.requests.push(record)
		return true
	}

	private isAppOrigin(url: string): boolean {
		const origin = safeOrigin(url)
		// With no known base URL, treat every origin as the app's: a footprint with
		// its origins mislabelled is better than an empty one.
		return origin !== null && (this.origins.size === 0 || this.origins.has(origin))
	}

	private templateFor(url: string): { route: string; params?: string[] } | null {
		const override = this.options.config.normalizeUrl
		if (override) {
			try {
				const custom = override(url)
				if (custom === null) return null
				if (custom !== undefined) return { route: custom }
			} catch (err) {
				this.warnings.add(`normalizeUrl threw (falling back to the built-in templating): ${message(err)}`)
			}
		}
		const appOrigin = this.isAppOrigin(url) ? safeOrigin(url) ?? undefined : undefined
		return toRouteTemplate(url, appOrigin)
	}

	/**
	 * Stop collecting and build the footprint. Must run while the page is still
	 * open — coverage and source maps are read through it. Never throws.
	 */
	async finish(page: Page): Promise<ScenarioFootprint> {
		this.dispose()
		// Walk the component tree one last time before the page closes. The
		// in-page walk is throttled, so whatever the scenario's LAST interaction
		// rendered is normally still unwalked at this point — and a scenario ends
		// with the context closing, not a navigation, so the page's own `pagehide`
		// sweep would never fire.
		if (this.collectors.has('components')) {
			try {
				await page.evaluate('window.__opiceFootprintSweep && window.__opiceFootprintSweep()')
			} catch {
				// Page already closed or navigating — the names we have are what we have.
			}
		}
		const files = new Map<string, FootprintFile>(this.modules)
		if (this.coverageStarted) {
			try {
				const coverage = await collectJsCoverage(page, this.context, this.options.config)
				for (const file of coverage.files) {
					if (files.size >= MAX_FILES && !files.has(file.path)) {
						this.truncatedFiles++
						continue
					}
					// Coverage is the stronger claim (executed, not merely loaded), so it
					// replaces a module-derived entry for the same path.
					files.set(file.path, file)
				}
				for (const warning of coverage.warnings) this.warnings.add(warning)
			} catch (err) {
				this.warnings.add(`JS coverage collection failed: ${message(err)}`)
			}
		}
		if (this.truncatedRequests > 0) {
			this.warnings.add(`${this.truncatedRequests} request(s) dropped — the per-scenario cap of ${MAX_REQUESTS} was reached.`)
		}
		if (this.truncatedFiles > 0) {
			this.warnings.add(`${this.truncatedFiles} file(s) dropped — the per-scenario cap of ${MAX_FILES} was reached.`)
		}
		if (this.persistedQueries > 0) {
			this.warnings.add(
				`${this.persistedQueries} persisted GraphQL request(s) carried only a hash — their fields and models are not in this footprint.`,
			)
		}
		const sortedFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
		const footprint: ScenarioFootprint = {
			scenario: this.options.scenario,
			...(this.options.testFile ? { testFile: this.options.testFile } : {}),
			collected: [...this.collectors],
			files: sortedFiles,
			components: [...this.components].sort(),
			requests: this.requests,
			endpoints: aggregateEndpoints(this.requests),
			models: aggregateModels(this.requests),
		}
		if (this.warnings.size > 0) footprint.warnings = [...this.warnings]
		return footprint
	}

	/** Detach every listener. Idempotent — `finish` calls it, a discarded attempt calls it directly. */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		try {
			this.context.off('request', this.onRequest)
			this.context.off('response', this.onResponse)
			this.context.off('requestfailed', this.onRequestFailed)
		} catch {
			// The context may already be closed.
		}
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
