/**
 * Footprint plugins — the public surface a repo's `browser-footprint.ts` imports.
 *
 * ```ts
 * import { fileRoutes } from '@opice/harness/plugins'
 *
 * export const footprint = {
 * 	plugins: [fileRoutes({ dir: 'app/routes' })],
 * }
 * ```
 *
 * **Additive, not replacing.** The built-in set is always present and `plugins`
 * adds to it — the opposite of the usual "your array replaces the default"
 * convention, and deliberately so: with framework conventions now living in
 * plugins, replace-semantics would let one added plugin silently switch off
 * Contember's `transaction` unwrapping. Removal is explicit, via `without`.
 */

export { PluginChain } from './chain.js'
export { contember } from './contember.js'
export { contemberSchema, type ContemberSchemaOptions } from './contember-schema.js'
export { fileRoutes, type FileRoutesOptions } from './file-routes.js'
export type {
	Dependency,
	FieldContext,
	FootprintHooks,
	FootprintPlugin,
	GraphqlConventions,
	PluginContext,
	RequestObservation,
	SegmentContext,
} from './types.js'

import { contember } from './contember.js'
import type { FootprintPlugin } from './types.js'

/**
 * Plugins every run gets. Keeping Contember's conventions here rather than in
 * the parser is what makes them removable; keeping them *on by default* is what
 * makes this refactor behaviour-neutral for every repo that already relies on
 * them without knowing it.
 */
export function defaultPlugins(): FootprintPlugin[] {
	return [contember()]
}

/**
 * The plugins for a run: the built-ins, minus anything named in `without`, plus
 * the repo's own.
 */
export function resolvePlugins(config: {
	plugins?: FootprintPlugin[]
	without?: string[]
}): FootprintPlugin[] {
	const excluded = new Set(config.without ?? [])
	return [...defaultPlugins().filter((plugin) => !excluded.has(plugin.name)), ...(config.plugins ?? [])]
}
