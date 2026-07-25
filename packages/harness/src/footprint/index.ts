/**
 * Footprint collection — what a scenario touched in the browser.
 *
 * See `types.ts` for the shape and the rules it lives by; `collector.ts` for the
 * observer that produces it. This barrel is what the rest of the harness (and
 * the platform's type imports) reach for.
 */

export { FootprintCollector, aggregateEndpoints, aggregateModels, type CollectorOptions } from './collector.js'
export { footprintDir, isIgnored, loadFootprintConfig, resolveMode, type FootprintConfig, type FootprintMode } from './config.js'
export { deriveModels, extractQueries, looksLikeGraphql, parseOperations, type ParsedOperation } from './graphql.js'
export { moduleUrlToSourcePath, normalizeSourceMapPath } from './modules.js'
export { toRouteTemplate } from './url.js'
export type {
	FootprintCollector as FootprintCollectorKind,
	FootprintEdgeKind,
	FootprintEndpoint,
	FootprintFile,
	FootprintModel,
	FootprintOperation,
	FootprintRequest,
	FootprintSummary,
	ScenarioFootprint,
} from './types.js'

import type { FootprintSummary, ScenarioFootprint } from './types.js'

/** How many model names a summary carries — enough for a badge row, not a list. */
const SUMMARY_MODEL_LIMIT = 8

/**
 * Reduce a footprint to the counts a list view needs, so the dashboard can badge
 * a scenario without fetching the whole blob out of R2. Written models come
 * first: "this scenario writes Invoice" is the fact worth seeing at a glance.
 */
export function summarize(footprint: ScenarioFootprint): FootprintSummary {
	const models = [...footprint.models].sort((a, b) => (Number(b.write) - Number(a.write)) || a.name.localeCompare(b.name))
	return {
		files: footprint.files.length,
		components: footprint.components.length,
		endpoints: footprint.endpoints.length,
		models: footprint.models.length,
		requests: footprint.requests.length,
		topModels: models.slice(0, SUMMARY_MODEL_LIMIT).map((m) => m.name),
		warnings: footprint.warnings?.length ?? 0,
	}
}

/** Is there anything worth shipping? An all-empty footprint is noise. */
export function isEmptyFootprint(footprint: ScenarioFootprint): boolean {
	return footprint.files.length === 0
		&& footprint.components.length === 0
		&& footprint.requests.length === 0
		&& (footprint.warnings?.length ?? 0) === 0
}
