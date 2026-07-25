/**
 * The **footprint** of a scenario — what the walkthrough actually touched in the
 * browser: source modules, React components, HTTP endpoints, GraphQL operations
 * and the data models behind them.
 *
 * This is deliberately NOT called "coverage". It carries no percentages, gates
 * nothing, and makes no claim to be exhaustive — it is *evidence*, in the same
 * family as a step screenshot. Two things read it:
 *
 *  - the dashboard, which shows "this scenario touches X" (and, inverted, "X is
 *    touched by these scenarios" / "nothing touches Y"),
 *  - `opice test --impacted`, which turns a git diff into a scenario selection.
 *
 * Nothing here may contain request/response bodies, headers, cookies or query
 * *values* — a footprint is shipped to the platform and rendered on a dashboard,
 * so it must be safe by construction. Only shapes: methods, path templates,
 * status codes, operation + field names.
 */

/** A queryable dimension of a footprint — one row-kind in the platform's edge index. */
export type FootprintEdgeKind = 'file' | 'component' | 'endpoint' | 'model'

/**
 * Which collectors produced data for a footprint. Recorded so a consumer can
 * tell "this scenario touches no files" apart from "file collection was off" —
 * the difference matters a lot to `--impacted`, where the first is a fact and
 * the second would silently select nothing.
 */
export type FootprintCollector = 'network' | 'graphql' | 'modules' | 'coverage' | 'components'

/** A data model (entity) the scenario touched, and whether it wrote to it. */
export interface FootprintModel {
	name: string
	/** True when reached through a mutation — a write is a stronger impact signal than a read. */
	write: boolean
}

/** One GraphQL operation carried by a request (a batched request carries several). */
export interface FootprintOperation {
	type: 'query' | 'mutation' | 'subscription'
	name?: string
	/**
	 * Top-level fields of the operation's selection set, with transparent wrapper
	 * fields (Contember's `transaction`) unwrapped. Aliases are resolved to the
	 * underlying field name.
	 */
	rootFields: string[]
	/** Models derived from `rootFields` (built-in heuristic or the repo's `mapOperation`). */
	models: FootprintModel[]
}

/** One API request the scenario made. Static asset requests are not recorded here. */
export interface FootprintRequest {
	/**
	 * 0-based sequence of the step that was active when the request started, or
	 * null when it happened outside any step (the scenario's opening navigation,
	 * or async traffic that outlived the step that triggered it).
	 */
	step: number | null
	method: string
	/** Path template — dynamic segments replaced by `:id`. Origin-qualified when cross-origin. */
	route: string
	/** Query parameter NAMES only, sorted. Never values — they carry tokens and PII. */
	params?: string[]
	status: number | null
	/** Playwright's resource type ('xhr', 'fetch', 'document', 'websocket', …). */
	resourceType: string
	durationMs: number | null
	operations?: FootprintOperation[]
}

/** A source file the scenario loaded or executed. */
export interface FootprintFile {
	/** Repo-relative path when resolvable, otherwise the raw module URL. */
	path: string
	/**
	 * How it was observed. 'module' — requested as an ES module by the dev server
	 * (loaded; not necessarily executed). 'coverage' — V8 reported executed bytes
	 * in it. A file seen both ways is reported once as 'coverage'.
	 */
	source: 'module' | 'coverage'
	/** Fraction of the file's bytes V8 saw execute (0..1). Only with source 'coverage'. */
	executed?: number
}

/** An endpoint aggregate, deduplicated across the scenario's requests. */
export interface FootprintEndpoint {
	route: string
	methods: string[]
	count: number
}

/**
 * A scenario's complete footprint — the blob shipped to the platform (and
 * written beside a local HTML report).
 */
export interface ScenarioFootprint {
	scenario: string
	testFile?: string
	/** Collectors that ran. Absence of a kind here means "not collected", not "none found". */
	collected: FootprintCollector[]
	files: FootprintFile[]
	components: string[]
	requests: FootprintRequest[]
	/** Aggregated from `requests`, so consumers don't each re-derive it. */
	endpoints: FootprintEndpoint[]
	/** Aggregated from every operation; `write` is true if ANY operation wrote to the model. */
	models: FootprintModel[]
	/**
	 * Anything that degraded collection — a truncated list, an unmappable bundle,
	 * a missing source map. Surfaced on the dashboard so a thin footprint is
	 * visibly thin rather than quietly wrong.
	 */
	warnings?: string[]
}

/** Compact counts + top entries, stored in D1 so a list view needn't fetch the blob. */
export interface FootprintSummary {
	files: number
	components: number
	endpoints: number
	models: number
	requests: number
	/** Model names (write ones first), capped — enough for a badge row. */
	topModels: string[]
	warnings: number
}
