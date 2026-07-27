/**
 * The footprint plugin interface.
 *
 * A footprint answers one question: **what does this scenario depend on?** Every
 * collector is a variation on one move — observe something the browser did, map
 * it to a dependency. That pattern was already in the code twice before it had a
 * name: the module collector turns an HTTP request into a source file (a dev
 * server's ES-module URL *is* the path), and the GraphQL collector turns an HTTP
 * request into a dependency it cannot name as a file, so it names it as an
 * entity instead.
 *
 * So the extension point is not "a hook inside the GraphQL parser" — it is
 * **an observation → dependencies**, with GraphQL as one layer some plugins
 * choose to work at. A twenty-line plugin maps `POST /api/invoices/:id` to
 * `app/routes/api.invoices.$id.ts` and turns an inert endpoint edge into a real
 * file dependency (see `file-routes.ts`).
 *
 * Two things bound this, and both are load-bearing:
 *
 *  - **Open interface, closed vocabulary.** Anyone can write a plugin, but the
 *    dimensions stay `files | components | endpoints | models`. That vocabulary
 *    is the wire contract with the platform's edge index, whose `indexableKinds`
 *    decides per dimension whether a run may *replace* what is already there. A
 *    plugin picks which dimensions it contributes to; it cannot invent a fifth.
 *  - **Derived data only.** Look at what the hooks receive: field names,
 *    argument key paths, a templated route, a path, a component name. No
 *    Playwright object, no request, no body, no headers, no argument values, no
 *    variables. There is nothing in a plugin's hands that isn't already in the
 *    footprint, which is what keeps the collector's no-leak invariant a property
 *    of the types rather than a promise. It is also why there is no page-level
 *    lifecycle hook: `onPageLoad(page)` would hand a plugin everything.
 *
 * A plugin that needs to read something — a schema, a route manifest — reads it
 * from the repo itself in {@link FootprintPlugin.bind}, as ordinary node code.
 * opice is not the one handing it over.
 */

import type { GqlFieldNode, ParsedOperation } from '../graphql.js'
import type { FootprintDimension, FootprintModel } from '../types.js'

/**
 * A dependency: **a path when knowable, a symbol when not.**
 *
 * Files are the goal — the platform's impact query is driven by changed paths,
 * and a plugin that can name the file removes a guess from the other end (the
 * worker matches a changed `api/model/Company.ts` against a model edge named
 * `Company` by basename). `model` is the fallback for a dependency the browser
 * can see but cannot locate in the repo.
 *
 * There is no `endpoint` here on purpose: an endpoint is what the collector
 * observes natively from the request itself, so a plugin has nothing to add to
 * it. Plugins still shape that dimension — through the {@link FootprintHooks.route}
 * and {@link FootprintHooks.segment} hooks, which is why they may still declare it.
 */
export type Dependency =
	| { kind: 'file'; path: string }
	| { kind: 'component'; name: string }
	| { kind: 'model'; name: string; write?: boolean }

/** Metadata about the scenario being collected. No page, no context, no request. */
export interface PluginContext {
	scenario: string
	testFile?: string
	/** The scenario's base URL, when it has one. */
	baseUrl?: string
	mode: 'network' | 'full'
}

/** A path segment, with enough context to judge it positionally. */
export interface SegmentContext extends PluginContext {
	index: number
	segments: readonly string[]
}

/** One top-level field of an operation, for the model rule chain. */
export interface FieldContext extends PluginContext {
	operation: ParsedOperation
}

/**
 * What a plugin sees of a request. Derived, not raw: the route is already
 * templated and the query already reduced to parameter NAMES, because a resolver
 * has no business with the values and the footprint would be the thing carrying
 * them if it did.
 */
export interface RequestObservation {
	method: string
	/** Path template, origin-qualified when cross-origin. */
	route: string
	/** Query parameter names only, sorted. */
	params?: string[]
	status: number | null
	/** Playwright's resource type ('xhr', 'fetch', 'document', 'websocket', …). */
	resourceType: string
	/** 0-based sequence of the step that was active, or null. */
	step: number | null
	/**
	 * Parsed GraphQL operations, when the request carried any — including the
	 * selection {@link ParsedOperation.fields tree} and argument key paths, which
	 * are deliberately NOT stored in the footprint. This is the one place they
	 * exist, which is the point: a resolver that knows the schema walks
	 * `['getInjury', 'account', 'company']` through it and lands on `Company`
	 * exactly, where the built-in name-shape heuristic can only read the root.
	 */
	graphql?: readonly ParsedOperation[]
}

/**
 * The seams. Every hook returns `undefined` to mean **"not mine, try the next
 * plugin"**; the chain runs the repo's own config hooks first, then plugins in
 * declaration order, then the built-in rule.
 *
 * A hook that throws is skipped — the chain continues, the collector does not
 * fail, and the plugin's declared dimensions are marked *partial* rather than
 * silently reported as complete-and-empty.
 */
export interface FootprintHooks {
	/**
	 * Raw URL → route template. `null` drops the request from the footprint
	 * entirely. Returns a plain string, like the config-level `normalizeUrl`, so
	 * it goes through the same sanitization on the way back: whatever a plugin
	 * returns is still stripped of query values and fragment. A rule written to
	 * fix one path has no reason to have thought about the `?token=` on the end.
	 */
	route?(url: string, context: PluginContext): string | null | undefined
	/** Additionally collapse a path segment to `:id`. Can only ADD redaction. */
	segment?(segment: string, context: SegmentContext): boolean | undefined
	/** One top-level field → the model it names. `null` = definitively not a model. */
	model?(field: GqlFieldNode, context: FieldContext): FootprintModel | null | undefined
	/** What does this request depend on? Runs once per recorded request, after the scenario ends. */
	resolve?(request: RequestObservation, context: PluginContext): Dependency[] | undefined
	/** An observed module / source path → repo-relative path, or `null` to drop it. */
	file?(path: string, context: PluginContext): string | null | undefined
	/** A component name off the fiber walk → a cleaned name, or `null` to drop it. */
	component?(name: string, context: PluginContext): string | null | undefined
}

/**
 * Conventions a plugin contributes to the GraphQL *parser*. Data rather than
 * hooks because the parser runs before any hook could see anything, and unioned
 * across plugins rather than overridden — two plugins both naming a transparent
 * wrapper is the normal case, and "last one wins" would disarm the first.
 */
export interface GraphqlConventions {
	/** Root fields whose children are the real operations (Contember: `transaction`). */
	transparentFields?: string[]
	/** Fields that never name a model (Contember: `_info`, `ok`, `errorMessage`). */
	ignoredRootFields?: string[]
	/** Extra verbs for the built-in verb+Entity rule. */
	readVerbs?: string[]
	writeVerbs?: string[]
}

export interface FootprintPlugin {
	/** Names the plugin in warnings. A warning that can't say who threw is half a warning. */
	name: string
	/**
	 * Dimensions this plugin contributes to. Optional, but it bounds the blast
	 * radius: when a hook throws we mark these partial, and if `bind` throws we
	 * have no hooks to reason about at all. Omitted → all four.
	 */
	dimensions?: FootprintDimension[]
	/** Parser conventions, unioned across plugins. */
	graphql?: GraphqlConventions
	/**
	 * Bind to one scenario. Called once per collector — which is what lets a
	 * plugin hold state: read the repo's schema once and close over it, or
	 * accumulate what it has seen across a scenario's requests.
	 */
	bind?(context: PluginContext): FootprintHooks | Promise<FootprintHooks>
}
