/**
 * Binding plugins to a scenario and running their hooks as a chain.
 *
 * This file is where the "a plugin cannot fail a run" invariant actually lives.
 * Every call crosses into third-party code, so every call is wrapped — and the
 * failure is not swallowed silently either, because the interesting half is what
 * a failure *means* for the index: a hook that threw leaves us not knowing what
 * it would have contributed, so its dimensions are marked **partial**, never
 * reported as collected-and-empty. Partial refuses to replace edges; empty
 * deletes them. That asymmetry is the whole reason the machinery exists.
 */

import type { GqlFieldNode, ParsedOperation } from '../graphql.js'
import type { FootprintDimension, FootprintModel } from '../types.js'
import type {
	Dependency,
	FieldContext,
	FootprintHooks,
	FootprintPlugin,
	GraphqlConventions,
	PluginContext,
	RequestObservation,
	SegmentContext,
} from './types.js'

const ALL_DIMENSIONS: readonly FootprintDimension[] = ['files', 'components', 'endpoints', 'models']

interface BoundPlugin {
	name: string
	dimensions: readonly FootprintDimension[]
	hooks: FootprintHooks
}

/**
 * Plugins bound to one scenario, exposing each seam as a single call.
 *
 * Ordering is fixed: the repo's own `browser-footprint.ts` hooks run before any
 * plugin (they are the most specific thing in the tree), plugins run in
 * declaration order, and the built-in rule is whatever the caller does when this
 * returns `undefined`.
 */
export class PluginChain {
	private readonly warned = new Set<string>()

	private constructor(
		private readonly plugins: readonly BoundPlugin[],
		private readonly context: PluginContext,
		/** Dimensions a hook failure has made unreliable. Folded into the footprint's `partial`. */
		readonly degraded = new Set<FootprintDimension>(),
		readonly warnings = new Set<string>(),
	) {}

	/**
	 * Bind every plugin. A `bind` that throws disables that plugin for the
	 * scenario and degrades its declared dimensions — we cannot know what it would
	 * have produced, so claiming its dimensions complete would be a guess in the
	 * one direction that deletes data.
	 */
	static async bind(plugins: readonly FootprintPlugin[], context: PluginContext): Promise<PluginChain> {
		const bound: BoundPlugin[] = []
		const degraded = new Set<FootprintDimension>()
		const warnings = new Set<string>()
		for (const plugin of plugins) {
			const dimensions = plugin.dimensions ?? ALL_DIMENSIONS
			if (!plugin.bind) continue
			try {
				bound.push({ name: plugin.name, dimensions, hooks: await plugin.bind(context) })
			} catch (err) {
				for (const dimension of dimensions) degraded.add(dimension)
				warnings.add(`footprint plugin '${plugin.name}' failed to start (ignored): ${message(err)}`)
			}
		}
		return new PluginChain(bound, context, degraded, warnings)
	}

	/** The parser conventions every plugin contributes, unioned. */
	static conventions(plugins: readonly FootprintPlugin[]): Required<GraphqlConventions> {
		const merged: Required<GraphqlConventions> = {
			transparentFields: [],
			ignoredRootFields: [],
			readVerbs: [],
			writeVerbs: [],
		}
		for (const plugin of plugins) {
			for (const key of Object.keys(merged) as (keyof GraphqlConventions)[]) {
				merged[key].push(...(plugin.graphql?.[key] ?? []))
			}
		}
		return merged
	}

	/**
	 * `null` is a deliberate "don't record this request", not a degradation — it
	 * is what the hook is *for* — so it propagates as an answer like any other.
	 */
	route(url: string): string | null | undefined {
		return this.first('route', (hooks) => hooks.route?.(url, this.context))
	}

	segment(segment: string, index: number, segments: readonly string[]): boolean {
		const context: SegmentContext = { ...this.context, index, segments }
		// OR, not first-wins: redaction can only ever be ADDED, so one plugin
		// wanting a segment collapsed is enough and order cannot matter.
		for (const plugin of this.plugins) {
			if (!plugin.hooks.segment) continue
			try {
				if (plugin.hooks.segment(segment, context) === true) return true
			} catch (err) {
				// The one seam where a throw does NOT mean "skip and carry on":
				// `:id` is the side that cannot leak, and a predicate that was asked
				// whether this segment is an id and couldn't answer is exactly when
				// that matters. Same rule the built-in templating already applies.
				this.fail(plugin, 'segment', err)
				return true
			}
		}
		return false
	}

	model(field: GqlFieldNode, operation: ParsedOperation): FootprintModel | null | undefined {
		const context: FieldContext = { ...this.context, operation }
		return this.first('model', (hooks) => hooks.model?.(field, context))
	}

	file(path: string): string | null | undefined {
		return this.first('file', (hooks) => hooks.file?.(path, this.context))
	}

	component(name: string): string | null | undefined {
		return this.first('component', (hooks) => hooks.component?.(name, this.context))
	}

	/**
	 * Every dependency the plugins derive from one request. Unlike the other
	 * seams this is not first-wins — a request can legitimately depend on a route
	 * file *and* an entity, named by two different plugins.
	 */
	resolve(request: RequestObservation): Dependency[] {
		const out: Dependency[] = []
		for (const plugin of this.plugins) {
			if (!plugin.hooks.resolve) continue
			try {
				out.push(...(plugin.hooks.resolve(request, this.context) ?? []))
			} catch (err) {
				this.fail(plugin, 'resolve', err)
			}
		}
		return out
	}

	/** Does any plugin implement this seam? Lets the collector skip the work entirely. */
	has(hook: keyof FootprintHooks): boolean {
		return this.plugins.some((plugin) => plugin.hooks[hook] !== undefined)
	}

	/**
	 * The collector stopped taking dependencies before the plugins stopped
	 * producing them. Which dimensions that cost is unknowable from here — a
	 * dropped dependency could have been a file or a model — so every dimension
	 * the bound plugins speak for is degraded.
	 */
	degradeAll(reason: string): void {
		for (const plugin of this.plugins) {
			for (const dimension of plugin.dimensions) this.degraded.add(dimension)
		}
		this.warnings.add(reason)
	}

	private first<T>(
		hook: keyof FootprintHooks,
		call: (hooks: FootprintHooks) => T | undefined,
	): T | undefined {
		for (const plugin of this.plugins) {
			if (plugin.hooks[hook] === undefined) continue
			try {
				const result = call(plugin.hooks)
				if (result !== undefined) return result
			} catch (err) {
				this.fail(plugin, hook, err)
			}
		}
		return undefined
	}

	/**
	 * A hook threw. The chain continues to the next plugin, but the dimensions
	 * this one speaks for can no longer be called complete — it may have been
	 * about to name the very dependency that would have kept a scenario selected.
	 */
	private fail(plugin: BoundPlugin, hook: string, err: unknown): void {
		for (const dimension of plugin.dimensions) this.degraded.add(dimension)
		// One warning per plugin+hook, however many requests hit it.
		const key = `${plugin.name}:${hook}`
		if (this.warned.has(key)) return
		this.warned.add(key)
		this.warnings.add(`footprint plugin '${plugin.name}' threw in its ${hook} hook (skipped): ${message(err)}`)
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
