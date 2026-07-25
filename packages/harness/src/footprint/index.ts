/**
 * Footprint collection — what a scenario touched in the browser.
 *
 * See `types.ts` for the shape and the rules it lives by; `collector.ts` for the
 * observer that produces it. This barrel is what the rest of the harness reaches
 * for. Note that the *platform* imports nothing from here: it mirrors the wire
 * types and validates on arrival (see `packages/worker/src/footprint.ts`),
 * because it has to accept payloads from every harness version in the wild.
 */

export { FootprintCollector, aggregateEndpoints, aggregateModels, type CollectorOptions } from './collector.js'
export { footprintDir, isIgnored, loadFootprintConfig, resolveMode, type FootprintConfig, type FootprintMode } from './config.js'
export { deriveModels, extractQueries, looksLikeGraphql, parseOperations, type ParsedOperation } from './graphql.js'
export { moduleUrlToSourcePath, normalizeSourceMapPath } from './modules.js'
export { toRouteTemplate } from './url.js'
export type {
	FootprintCollectorKind,
	FootprintEdgeKind,
	FootprintEndpoint,
	FootprintFile,
	FootprintModel,
	FootprintOperation,
	FootprintRequest,
	ScenarioFootprint,
} from './types.js'
