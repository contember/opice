/** Operations → data models: which entities the scenario read and wrote. */

import type { FootprintModel, FootprintOperation } from '../types.js'
import type { GqlFieldNode, ParsedOperation } from './parse.js'

/**
 * Root-field verbs that name an entity. Contember generates
 * `list|get|paginate + Entity` for reads and `create|update|delete|upsert +
 * Entity` for writes; the same convention covers most hand-written schemas
 * (`createUser`, `updateInvoice`, `deleteComment`).
 */
const READ_VERBS = ['list', 'get', 'paginate', 'find', 'fetch', 'search']
const WRITE_VERBS = ['create', 'update', 'delete', 'upsert', 'remove', 'add', 'set', 'save']

/** Verb regexes are per verb-set, not per call — the set is stable for a whole run. */
const verbCache = new Map<string, RegExp>()

function verbPattern(read: readonly string[], write: readonly string[]): RegExp {
	const key = `${read.join('|')}::${write.join('|')}`
	const hit = verbCache.get(key)
	if (hit) return hit
	const compiled = new RegExp(`^(${[...read, ...write].join('|')})([A-Z][A-Za-z0-9_]*)$`)
	verbCache.set(key, compiled)
	return compiled
}

/** How plugins extend the built-in derivation. See `plugins/types.ts`. */
export interface ModelDerivation {
	readVerbs?: Iterable<string>
	writeVerbs?: Iterable<string>
	/**
	 * Plugin rule chain, tried before the verb heuristic. `null` means
	 * "definitively not a model" and stops the fall-through; `undefined` means
	 * "not mine".
	 */
	field?(node: GqlFieldNode, operation: ParsedOperation): FootprintModel | null | undefined
}

/**
 * Derive the models an operation touches from its top-level fields.
 *
 * The built-in heuristic only claims a model when the field follows the
 * verb+Entity convention — a field it can't read (`viewer`, `me`, `node`) yields
 * NO model rather than a guessed one. That's deliberate: a wrong model on the
 * dashboard is worse than a missing one. Framework conventions that the verb
 * shape can't express (Contember's `validateCreateArticle`) are plugin rules,
 * not constants here. The raw `rootFields` are always reported either way, so
 * nothing is lost.
 */
export function deriveModels(operation: ParsedOperation, options: ModelDerivation = {}): FootprintModel[] {
	const writeVerbs = [...WRITE_VERBS, ...(options.writeVerbs ?? [])]
	const pattern = verbPattern([...READ_VERBS, ...(options.readVerbs ?? [])], writeVerbs)
	const writeSet = new Set(writeVerbs)
	const byName = new Map<string, boolean>()
	// A model already seen as written stays written: a validation (a read) must
	// not downgrade an entity a sibling field really does write.
	const add = (model: FootprintModel) => byName.set(model.name, (byName.get(model.name) ?? false) || model.write)
	for (const node of topLevelNodes(operation)) {
		const ruled = options.field?.(node, operation)
		if (ruled !== undefined) {
			if (ruled !== null) add(ruled)
			continue
		}
		const match = pattern.exec(node.name)
		if (!match) continue
		const verb = match[1] as string
		const entity = match[2] as string
		// A mutation's reads are still writes in effect — the operation as a whole
		// changes state — but the verb is the sharper signal, so it wins.
		add({ name: entity, write: writeSet.has(verb) || operation.type === 'mutation' })
	}
	return [...byName].map(([name, write]) => ({ name, write }))
}

/**
 * The nodes to derive models from. Falls back to synthesizing them from
 * `rootFields` for an operation built by hand rather than by {@link parseOperations}
 * — a user's `mapOperation` receives one, and so do older tests.
 */
function topLevelNodes(operation: ParsedOperation): GqlFieldNode[] {
	if (operation.fields && operation.fields.length > 0) return operation.fields
	return operation.rootFields.map((name) => ({ name, path: [name] }))
}

/** Attach derived models to a parsed operation. */
export function toFootprintOperation(operation: ParsedOperation, models?: FootprintModel[]): FootprintOperation {
	return {
		type: operation.type,
		...(operation.name ? { name: operation.name } : {}),
		rootFields: operation.rootFields,
		models: models ?? deriveModels(operation),
	}
}
