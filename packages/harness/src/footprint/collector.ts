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
 * The API request stream is the {@link RequestRecorder}'s (`requests.ts`); what
 * stays here is the source-module half, the page-level collectors it orchestrates
 * (V8 coverage, the React fiber walk) and the assembly of the footprint itself.
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
import { DegradationLedger, MAX_FILES } from './degradation.js'
import { moduleUrlToSourcePath } from './modules.js'
import { PluginChain } from './plugins/chain.js'
import { resolvePlugins } from './plugins/index.js'
import type { Dependency, GraphqlConventions, RequestObservation } from './plugins/types.js'
import { aggregateEndpoints, aggregateModels, RequestRecorder } from './requests.js'
import type {
	FootprintCollectorKind,
	FootprintDimension,
	FootprintFile,
	FootprintModel,
	ScenarioFootprint,
} from './types.js'

// Another cap on what one scenario may record. `MAX_REQUESTS`/`MAX_FILES` live
// in `degradation.ts`, beside the warning that reports them; this one is not
// reported by count, so it needs no signal of its own.
/** Dependencies one scenario's plugins may emit. A runaway resolver is still a runaway. */
const MAX_PLUGIN_DEPENDENCIES = 5000

export interface CollectorOptions {
	scenario: string
	testFile?: string
	/** The scenario's base URL — its origin is what counts as "the app". */
	baseUrl?: string
	mode: FootprintMode
	config: FootprintConfig
}

export class FootprintCollector {
	/** path → how it was seen. Coverage results are merged over these at finish. */
	private readonly modules = new Map<string, FootprintFile>()
	private readonly components = new Set<string>()
	/**
	 * Everything that went wrong with collection itself. Both halves of the report —
	 * the warnings a human reads and the partial dimensions the index acts on — come
	 * out of here, so a new signal is declared in one place. See `degradation.ts`.
	 */
	private readonly degradation = new DegradationLedger()
	/** The API request stream, and everything derived from a request. See `requests.ts`. */
	private readonly recorder: RequestRecorder
	private readonly collectors = new Set<FootprintCollectorKind>()
	private coverageStarted = false
	private disposed = false

	private constructor(
		private readonly context: BrowserContext,
		private readonly options: CollectorOptions,
		/** Plugins bound to this scenario. See `plugins/types.ts`. */
		private readonly plugins: PluginChain,
		/** Parser conventions the plugins contribute, unioned. */
		conventions: Required<GraphqlConventions>,
	) {
		this.recorder = new RequestRecorder(options, plugins, conventions, this.degradation)
	}

	/**
	 * Attach a collector to a freshly created context, before its first
	 * navigation. Returns null when collection is off — the caller then pays
	 * nothing at all, not even a no-op listener.
	 */
	static async attach(context: BrowserContext, page: Page, options: CollectorOptions): Promise<FootprintCollector | null> {
		if (options.mode === 'off') return null
		const plugins = resolvePlugins(options.config)
		const bound = await PluginChain.bind(plugins, {
			scenario: options.scenario,
			...(options.testFile ? { testFile: options.testFile } : {}),
			...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
			mode: options.mode,
		})
		const collector = new FootprintCollector(context, options, bound, PluginChain.conventions(plugins))
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
		this.recorder.attach(this.context)
		this.collectors.add('network')
		this.collectors.add('graphql')
		this.collectors.add('modules')
		// Every page, not just the first: a WebSocket opened by a popup or a new tab
		// is invisible to a listener bound to the initial page, and the network
		// dimension would still report itself complete without it. HTTP traffic is
		// already context-wide (the `request` event above), so this closes the one
		// per-page hole left.
		this.recorder.watchWebSockets(page)
		this.context.on('page', (opened) => this.recorder.watchWebSockets(opened))
		if (this.options.mode !== 'full') return
		// Component names: the binding must exist before the init script runs, or
		// the page's first flush lands on an undefined function.
		try {
			await this.context.exposeBinding(COMPONENT_BINDING, (_source, payload: unknown) => {
				// A bare array is the older shape; the object carries the cap signal.
				const names = Array.isArray(payload) ? payload : (payload as { names?: unknown })?.names
				if (!Array.isArray(names)) return
				for (const name of names) {
					if (typeof name !== 'string' || !name) continue
					// A plugin may clean the name (`withRouter(Foo)` → `Foo`) or drop it.
					const mapped = this.plugins.component(name)
					if (mapped === null) continue
					this.components.add(mapped ?? name)
				}
				if (!Array.isArray(payload) && (payload as { truncated?: unknown })?.truncated === true) {
					this.degradation.note('componentsTruncated')
				}
			})
			await this.context.addInitScript(COMPONENT_SCRIPT)
			this.collectors.add('components')
		} catch (err) {
			this.degradation.warn(`component collection unavailable: ${message(err)}`)
		}
		// Coverage instruments THIS page. A popup or a new tab is a page it never
		// sees, so its scripts are invisible to the source-map pass — and if they
		// are bundled, nothing else can name them either. Noted here so the file
		// dimension can refuse to claim completeness in that case rather than
		// silently omitting the popup's sources from the index.
		this.context.on('page', () => { this.degradation.note('uninstrumentedPages') })

		if (await startJsCoverage(page)) {
			this.coverageStarted = true
			this.collectors.add('coverage')
		} else {
			this.degradation.warn('V8 JS coverage is unavailable in this browser — file footprint falls back to loaded modules.')
		}
	}

	/**
	 * Point subsequent traffic at a step. The recorder attributes requests at
	 * *start*; see {@link RequestRecorder.setActiveStep}.
	 */
	setActiveStep(sequence: number | null): void {
		this.recorder.setActiveStep(sequence)
	}

	/**
	 * The one request listener the collector keeps. Scripts and stylesheets are the
	 * module collector's business, everything else is the recorder's — dispatching
	 * here rather than handing the recorder a way back into this class is what keeps
	 * the dependency between the two one-way.
	 */
	private readonly onRequest = (request: Request): void => {
		try {
			const resourceType = request.resourceType()
			if (resourceType === 'script' || resourceType === 'stylesheet') {
				this.recordModule(request.url(), resourceType)
				return
			}
			this.recorder.record(request)
		} catch {
			// An observer must never break the page it observes.
		}
	}

	/** A dev server's module request doubles as the identity of a source file. */
	private recordModule(url: string, resourceType: 'script' | 'stylesheet'): void {
		if (!this.recorder.isAppOrigin(url)) return
		const mapped = moduleUrlToSourcePath(url, this.options.config.sourceRoot)
		if (mapped.bundled) {
			// The collector ran and recognised nothing: a bundle's chunk names are not
			// source paths. Recorded, not just warned, because "no files" from here
			// means "could not tell", and the index must not mistake it for "touches
			// no files" and delete what a dev-server run established.
			//
			// Scripts and stylesheets are counted apart because only ONE of them has a
			// second chance: V8 coverage resolves JS through its source maps and knows
			// nothing about CSS. Folding them together let a build with mappable JS
			// and a bundled stylesheet report the file dimension complete while every
			// CSS source was missing from it.
			if (resourceType === 'stylesheet') this.degradation.note('unmappableStyles')
			else this.degradation.note('unmappableScripts')
			// Phrased here rather than declared on the signal: it fires on the raw
			// observation, before coverage has had its second chance at the scripts.
			this.degradation.warn(
				'the app under test is serving bundled assets — file-level footprint needs a dev server or source maps.',
			)
			return
		}
		if (!mapped.path) return
		// A plugin gets to rewrite the path (a served path that isn't the repo's) or
		// drop it. `ignore` runs after, because a repo writes its ignore rules in
		// terms of final repo-relative paths.
		const fromPlugin = this.plugins.file(mapped.path)
		if (fromPlugin === null) return
		const filePath = fromPlugin ?? mapped.path
		if (isIgnored(filePath, this.options.config.ignore)) return
		// The `has` check comes FIRST: at exactly the cap, a repeat request for a
		// module already recorded drops nothing, and counting it as truncation would
		// mark an otherwise complete footprint partial and stop it refreshing the
		// index. Only a path that would have been ADDED can be dropped.
		if (this.modules.has(filePath)) return
		if (this.modules.size >= MAX_FILES) {
			this.degradation.note('truncatedFiles')
			return
		}
		this.modules.set(filePath, { path: filePath, source: 'module' })
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
			// EVERY open page, not just the scenario's first. A popup runs its own
			// copy of the init script with its own throttle timer, and that timer is
			// cancelled when the context closes — so without sweeping it, whatever
			// its last interaction rendered never arrives, while the component
			// dimension still reports itself complete.
			const pages = new Set<Page>([page, ...this.context.pages()])
			let installed = false
			for (const open of pages) {
				try {
					// The sweep function exists only where the script actually installed
					// its hook. It bails out when the app already has a real DevTools
					// hook — deliberately, so a developer's tools are never hijacked —
					// and in that case it collected nothing at all. Reporting that empty
					// list as authoritative would replace the scenario's component edges
					// with nothing, and component changes would stop selecting it.
					const ran = await open.evaluate<boolean>(
						'!!window.__opiceFootprintSweep && (window.__opiceFootprintSweep(), true)',
					)
					if (ran) installed = true
				} catch {
					// Closed, navigating, or never ran the script — the names we have
					// are the names we have.
				}
			}
			// No page could confirm the hook. Treated as "could not tell" rather than
			// "found none": a page that closed early reports the same way, and both
			// are safer read as partial than as an authoritative empty set.
			if (!installed) this.degradation.note('componentsTruncated')
		}
		const files = new Map<string, FootprintFile>(this.modules)
		if (this.coverageStarted) {
			try {
				const coverage = await collectJsCoverage(page, this.context, this.options.config)
				// Coverage is the authority on whether a bundle was resolvable: it is
				// the pass that reads the source maps. The derived `unmappableFiles`
				// signal only counts what the MODULE collector couldn't name, which for
				// a bundled app is every script — including the ones coverage then maps
				// perfectly. `failed` is not the same as "resolved nothing": a pass that
				// could not be read at all resolved no bundles either, and taking its
				// empty file list as authoritative would let it wipe the index.
				if (coverage.failed) this.degradation.note('coverageFailed')
				else this.degradation.note('coverageRan')
				this.degradation.note('unmappedBundles', coverage.unmappedBundles)
				for (const file of coverage.files) {
					if (files.size >= MAX_FILES && !files.has(file.path)) {
						this.degradation.note('truncatedFiles')
						continue
					}
					// Coverage is the stronger claim (executed, not merely loaded), so it
					// replaces a module-derived entry for the same path.
					files.set(file.path, file)
				}
				for (const warning of coverage.warnings) this.degradation.warn(warning)
			} catch (err) {
				// Coverage was started, so the file dimension was expected to come from
				// it; failing here means the file list is whatever the module collector
				// happened to see, which against a bundle is nothing.
				this.degradation.note('coverageFailed')
				this.degradation.warn(`JS coverage collection failed: ${message(err)}`)
			}
		}
		const requests = this.recorder.requests
		const models = aggregateModels(requests)
		this.applyDependencies(files, models)
		const sortedFiles = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
		const footprint: ScenarioFootprint = {
			scenario: this.options.scenario,
			...(this.options.testFile ? { testFile: this.options.testFile } : {}),
			collected: [...this.collectors],
			files: sortedFiles,
			components: [...this.components].sort(),
			requests,
			endpoints: aggregateEndpoints(requests),
			models,
		}
		// The plugins keep their own tally (the chain owns it, since a hook that
		// throws is its business), so both halves are merged in here at the end.
		const warnings = new Set<string>([...this.degradation.warnings(), ...this.plugins.warnings])
		if (warnings.size > 0) footprint.warnings = [...warnings]
		// The same facts as the warnings above, in a form a consumer can act on.
		// A plugin that threw leaves us not knowing what it would have contributed,
		// so the dimensions it speaks for are no longer authoritative. Partial only
		// ever refuses to replace edges; reporting them complete would delete some.
		const degraded = new Set<FootprintDimension>([...this.degradation.dimensions(), ...this.plugins.degraded])
		if (degraded.size > 0) footprint.partial = [...degraded]
		return footprint
	}

	/**
	 * Fold the plugins' dependencies into the footprint.
	 *
	 * Runs once at the end rather than per request event: by now the statuses are
	 * known, and a hook that throws can't take the page's request handler with it.
	 */
	private applyDependencies(files: Map<string, FootprintFile>, models: FootprintModel[]): void {
		if (!this.plugins.has('resolve')) return
		const byModel = new Map(models.map((model, index) => [model.name, index]))
		let emitted = 0
		for (const request of this.recorder.requests) {
			if (emitted >= MAX_PLUGIN_DEPENDENCIES) {
				// NOT a `truncatedFiles` note: a dropped dependency could have been a
				// model just as easily as a file, and marking only the file dimension
				// partial would leave the model edges looking authoritative on a sample.
				this.plugins.degradeAll(
					`plugin dependencies past the per-scenario cap of ${MAX_PLUGIN_DEPENDENCIES} were dropped — this footprint is a sample.`,
				)
				break
			}
			const graphql = this.recorder.parsedFor(request)
			const observation: RequestObservation = {
				method: request.method,
				route: request.route,
				...(request.params ? { params: request.params } : {}),
				status: request.status,
				resourceType: request.resourceType,
				step: request.step,
				...(graphql ? { graphql } : {}),
			}
			for (const dependency of this.plugins.resolve(observation)) {
				emitted++
				this.applyDependency(dependency, files, models, byModel)
			}
		}
	}

	private applyDependency(
		dependency: Dependency,
		files: Map<string, FootprintFile>,
		models: FootprintModel[],
		byModel: Map<string, number>,
	): void {
		if (dependency.kind === 'component') {
			this.components.add(dependency.name)
			return
		}
		if (dependency.kind === 'model') {
			const index = byModel.get(dependency.name)
			if (index === undefined) {
				byModel.set(dependency.name, models.length)
				models.push({ name: dependency.name, write: dependency.write === true })
				return
			}
			const existing = models[index] as FootprintModel
			existing.write = existing.write || dependency.write === true
			return
		}
		// A file the collector MEASURED is left alone: coverage and the module
		// collector observed what the browser did, where a plugin infers what the
		// repo implies, and measurement wins where the two overlap.
		if (files.has(dependency.path)) return
		if (files.size >= MAX_FILES) {
			this.degradation.note('truncatedFiles')
			return
		}
		// `exercised` is true because a resolver's claim IS a usage claim — the
		// scenario called this endpoint or queried this entity. That is a different
		// statement from the module collector's "the browser loaded this", which is
		// exactly the one that saturates and gets filtered out of impact selection.
		files.set(dependency.path, { path: dependency.path, source: 'plugin', exercised: true })
	}

	/** Detach every listener. Idempotent — `finish` calls it, a discarded attempt calls it directly. */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		try {
			this.context.off('request', this.onRequest)
			this.recorder.detach(this.context)
		} catch {
			// The context may already be closed.
		}
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

export { aggregateEndpoints, aggregateModels, splitCustomRoute } from './requests.js'
