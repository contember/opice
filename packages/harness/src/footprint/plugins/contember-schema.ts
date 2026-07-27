/**
 * Contember schema resolver — the plugin that closes the nested-relation gap.
 *
 * The built-in derivation reads an operation's ROOT field and stops there, so
 * `listSupplierInvoice { linkedContract { counterpartyOrganization { name } } }`
 * reports one model, `SupplierInvoice`. The scenario genuinely depends on
 * `Contract` and `Organization` too — edit either and it can break — but nothing
 * in the request says so, because a field name is not an entity name
 * (`counterpartyOrganization` → `Organization`, `correctiveActions` →
 * `CorrectiveAction`, `createdBy` → whatever the schema says).
 *
 * The repo knows. Contember schemas are `export class Entity { field =
 * c.manyHasOne(Target) }`, which is a relation graph in the source tree, so this
 * reads it once per run and walks each field's `path` through it. Exact,
 * not guessed — an unknown segment resolves to nothing rather than to an
 * invented entity.
 *
 * It emits **files as well as models**, which is the better half: a model edge
 * called `SupplierInvoice` only matches a changed path through the worker's
 * basename heuristic, and that heuristic cannot match `supplier-invoice.ts` —
 * the two differ by more than case. A file dependency naming the defining file
 * matches exactly.
 */

import { readFileSync } from 'node:fs'
import type { GqlFieldNode, ParsedOperation } from '../graphql.js'
import { blankOutTypeScriptLiterals, findBlockEnd } from '../graphql/scan.js'
import type { Dependency, FootprintPlugin, RequestObservation } from './types.js'
import { listFiles } from './walk.js'

export interface ContemberSchemaOptions {
	/**
	 * Directory (or directories) holding the model definitions, repo-relative —
	 * `packages/api/model`. Paths are emitted as they are joined here, so a
	 * repo-relative `dir` yields repo-relative dependencies, which is what the
	 * impact query matches against.
	 */
	dir: string | string[]
	/** Also emit the entity's defining file, not just its name. Default true. */
	files?: boolean
}

/** Verbs Contember generates onto the schema roots, longest first so `upsert` beats `set`. */
const ROOT_VERBS = ['validateCreate', 'validateUpdate', 'validateUpsert', 'validateDelete', 'paginate', 'create', 'update', 'delete', 'upsert', 'list', 'get']

/**
 * Selection fields that wrap the entity rather than being a relation on it: a
 * mutation's `node` payload and a paginated connection's `edges { node }`.
 * Walking through them keeps the path aligned with the schema.
 */
const TRANSPARENT_SELECTIONS = new Set(['node', 'edges', 'pageInfo'])

/**
 * Leading argument names whose object body is a relation path — a filter, a
 * `by`, a mutation's `data`. `filter.linkedContract.counterpartyOrganization.name.eq`
 * says this query depends on `Organization` just as loudly as selecting it does.
 */
const RELATION_ARGUMENTS = new Set(['filter', 'by', 'data', 'where', 'having', 'orderBy'])

interface Entity {
	name: string
	file: string
	/** Relation field → target entity name. */
	relations: Map<string, string>
}

export function contemberSchema(options: ContemberSchemaOptions): FootprintPlugin {
	const dirs = Array.isArray(options.dir) ? options.dir : [options.dir]
	const withFiles = options.files !== false
	return {
		name: 'contember-schema',
		dimensions: ['models', 'files'],
		bind: () => {
			// Read once and close over it. This is what `bind` is for — no table of
			// strings can express "walk the repo's own entity graph".
			const entities = cachedEntityGraph(dirs)
			return {
				resolve: (request) => resolveDependencies(request, entities, withFiles),
			}
		},
	}
}

function resolveDependencies(
	request: RequestObservation,
	entities: Map<string, Entity>,
	withFiles: boolean,
): Dependency[] {
	if (!request.graphql || entities.size === 0) return []
	const out: Dependency[] = []
	const seen = new Set<string>()
	const emit = (entity: Entity, write: boolean): void => {
		const key = `${entity.name}:${write}`
		if (seen.has(key)) return
		seen.add(key)
		out.push({ kind: 'model', name: entity.name, write })
		if (withFiles && !seen.has(`file:${entity.file}`)) {
			seen.add(`file:${entity.file}`)
			out.push({ kind: 'file', path: entity.file })
		}
	}
	for (const operation of request.graphql) {
		for (const node of operation.fields ?? []) walk(node, operation, entities, emit)
	}
	return out
}

function walk(
	node: GqlFieldNode,
	operation: ParsedOperation,
	entities: Map<string, Entity>,
	emit: (entity: Entity, write: boolean) => void,
): void {
	const root = rootEntity(node.name, entities)
	if (!root) return
	// The root's write-ness is the built-in derivation's business; everything this
	// plugin reaches through a relation is a READ of that entity.
	emit(root, operation.type === 'mutation' && !node.name.startsWith('validate'))
	for (const argument of node.args ?? []) walkArgument(argument, root, entities, emit)
	for (const child of node.children ?? []) walkSelection(child, root, entities, emit)
}

function walkSelection(
	node: GqlFieldNode,
	current: Entity,
	entities: Map<string, Entity>,
	emit: (entity: Entity, write: boolean) => void,
): void {
	let entity = current
	if (!TRANSPARENT_SELECTIONS.has(node.name)) {
		const target = current.relations.get(node.name)
		// Not a relation: a scalar column, or a field this reader didn't understand.
		// Either way the branch stops here rather than guessing an entity from the name.
		if (!target) return
		const resolved = entities.get(target)
		if (!resolved) return
		emit(resolved, false)
		entity = resolved
	}
	for (const child of node.children ?? []) walkSelection(child, entity, entities, emit)
}

/** `filter.linkedContract.counterpartyOrganization.name.eq` → Contract, Organization. */
function walkArgument(
	argument: string,
	root: Entity,
	entities: Map<string, Entity>,
	emit: (entity: Entity, write: boolean) => void,
): void {
	const segments = argument.split('.')
	const first = segments[0]
	if (!first || !RELATION_ARGUMENTS.has(first)) return
	let current = root
	for (const segment of segments.slice(1)) {
		const target = current.relations.get(segment)
		if (!target) return
		const resolved = entities.get(target)
		if (!resolved) return
		emit(resolved, false)
		current = resolved
	}
}

/** `listSupplierInvoice` / `validateCreateImage` → the entity, when the schema has one by that name. */
function rootEntity(field: string, entities: Map<string, Entity>): Entity | undefined {
	for (const verb of ROOT_VERBS) {
		if (!field.startsWith(verb)) continue
		const candidate = field.slice(verb.length)
		const entity = candidate && entities.get(candidate)
		if (entity) return entity
	}
	// A root field that isn't verb+Entity (`me`, a custom resolver) names nothing.
	return undefined
}

/**
 * Per-process cache of the parsed graph.
 *
 * `bind` runs once per SCENARIO, and reading a real schema costs ~50 ms (304
 * entities across 95 files) — which is 10 seconds of re-parsing an unchanging
 * source tree over a 200-scenario suite. The repo cannot change under a running
 * test run, so this is read once per directory set and shared. A schema edited
 * mid-run is seen by the next `opice test`, not by the scenario that is already
 * walking it, which is the same deal the module graph gets.
 */
const graphCache = new Map<string, Map<string, Entity>>()

function cachedEntityGraph(dirs: readonly string[]): Map<string, Entity> {
	const key = dirs.join('\0')
	const hit = graphCache.get(key)
	if (hit) return hit
	const graph = readEntityGraph(dirs)
	graphCache.set(key, graph)
	return graph
}

/**
 * Parse the schema into `entity → { file, relations }`.
 *
 * A scanner rather than a TypeScript parse: pulling `typescript` into the *test
 * runtime* to read `class X { y = c.manyHasOne(Z) }` would be absurd, and the
 * definition style is declarative enough that a scan is exact for it. Anything
 * it fails to recognise becomes a relation it doesn't know, which costs a
 * dependency — never a wrong one.
 */
export function readEntityGraph(dirs: readonly string[]): Map<string, Entity> {
	const entities = new Map<string, Entity>()
	for (const dir of dirs) {
		for (const file of listFiles(dir, { extensions: ['.ts', '.tsx'] })) {
			let source: string
			try {
				source = blankOutTypeScriptLiterals(readFileSync(file, 'utf8'))
			} catch {
				continue
			}
			for (const entity of parseEntities(source, file)) {
				// First definition wins; a schema cannot have two entities of one name.
				if (!entities.has(entity.name)) entities.set(entity.name, entity)
			}
		}
	}
	return entities
}

const CLASS_RE = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/g
/** `field = c.manyHasOne(Target` — any namespace, since a repo may import the builder as `c` or `def`. */
const RELATION_RE = /([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*(?:manyHasOne|oneHasMany|oneHasOne|manyHasMany)\s*\(\s*([A-Za-z_$][\w$]*)/g

function parseEntities(source: string, file: string): Entity[] {
	const out: Entity[] = []
	CLASS_RE.lastIndex = 0
	let match: RegExpExecArray | null
	while ((match = CLASS_RE.exec(source)) !== null) {
		const brace = source.indexOf('{', match.index + match[0].length)
		if (brace === -1) continue
		const end = matchBrace(source, brace)
		const body = source.slice(brace + 1, end)
		const relations = new Map<string, string>()
		RELATION_RE.lastIndex = 0
		let relation: RegExpExecArray | null
		while ((relation = RELATION_RE.exec(body)) !== null) {
			relations.set(relation[1] as string, relation[2] as string)
		}
		out.push({ name: match[1] as string, file, relations })
		CLASS_RE.lastIndex = end
	}
	return out
}

/** Index of the class body's closing brace, or the end of the source for a truncated file. */
function matchBrace(source: string, open: number): number {
	const end = findBlockEnd(source, open, '{', '}')
	return end === -1 ? source.length : end
}

