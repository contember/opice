/**
 * GraphQL request → operations → data models.
 *
 * A footprint's most useful dimension for a full-stack repo isn't the URL — every
 * GraphQL call hits the same `/graphql` — it's *which entities* the scenario read
 * and wrote. That is recoverable from the request body alone: the operation type
 * and the top-level fields of its selection set.
 *
 * This parses only as far as it needs to. There is no dependency on the `graphql`
 * package: pulling a full parser (and its schema machinery) into the *test
 * runtime* to read the first level of a selection set would be absurd. What is
 * needed is a tolerant scanner that survives comments, strings, aliases,
 * variables, directives and fragments — everything below does exactly that and
 * nothing more.
 *
 * **Only names are extracted.** Variables are never read: `variables` is where
 * the passwords, tokens and personal data live, and a footprint is rendered on a
 * dashboard.
 */

import type { FootprintModel, FootprintOperation } from './types.js'

/** A raw operation as it came off the wire, before models are derived. */
export interface ParsedOperation {
	type: 'query' | 'mutation' | 'subscription'
	name?: string
	rootFields: string[]
	/**
	 * The selection tree. Deliberately NOT stored in the footprint: its only
	 * consumer is a plugin's `resolve` hook, which runs here during collection.
	 * Keeping it out of the blob is what lets it be generous — a stored tree would
	 * be 500 nodes times 2000 requests.
	 */
	fields?: GqlFieldNode[]
	/** A cap was hit while building the tree, so it is a sample. Marks `models` partial. */
	truncated?: boolean
}

/**
 * One field of a selection set.
 *
 * `path` is what makes this useful for dependency tracking: a resolver that
 * knows the schema walks `['getInjury', 'account', 'company']` through the
 * entity graph and lands on `Company` exactly, where a name-shape heuristic
 * would have to guess (`correctiveActions` → `CorrectiveAction` needs
 * singularization; `createdBy` → `Author` is unknowable).
 */
export interface GqlFieldNode {
	/** Field name, alias already resolved. */
	name: string
	/** Path from the operation root, transparent wrappers removed. */
	path: string[]
	/** Argument object key paths — names only, never values. See {@link parseArgumentKeys}. */
	args?: string[]
	children?: GqlFieldNode[]
}

/**
 * Per-operation cap on tree nodes. A document that selects a thousand fields is
 * a report, not a dependency; hitting this marks the operation truncated, which
 * marks the model dimension partial, because a sampled tree is not a tree.
 */
const MAX_FIELD_NODES = 500
/** How deep the tree goes. Past this a path is long enough that nothing resolves it anyway. */
const MAX_FIELD_DEPTH = 8
/** Per-field cap on argument key paths — a generated filter can be enormous. */
const MAX_FIELD_ARGS = 32

/**
 * Fields that never name a model **in any schema**, so they stay built in and a
 * plugin cannot remove them: `__schema`/`__type`/`__typename` are introspection,
 * defined by the spec.
 *
 * (`query` is here for behaviour parity with the pre-plugin collector, where it
 * sat in the same list. Whether it is spec-level or a framework convention that
 * belongs in a plugin is unresolved — see the design doc's open questions.)
 *
 * Framework conventions live in plugins: Contember's `_info`, `ok` and
 * `errorMessage` come from `plugins/contember.ts`.
 */
const BUILTIN_IGNORED_FIELDS = new Set(['__schema', '__type', '__typename', 'query'])

export interface ExtractedQueries {
	/** Query documents found in the request, each with the operation the client selected (if any). */
	documents: { query: string; operationName?: string }[]
	/**
	 * Count of persisted queries (an APQ hash with no document). Their fields are
	 * unrecoverable client-side — the collector warns rather than reporting an
	 * empty operation as if the scenario touched nothing.
	 */
	persisted: number
}

/**
 * Pull GraphQL documents out of a request body. Handles the three shapes in the
 * wild: a single JSON `{query, operationName}`, a JSON array (batched), and a
 * raw `application/graphql` body.
 */
export function extractQueries(body: string | undefined, contentType?: string): ExtractedQueries {
	const empty: ExtractedQueries = { documents: [], persisted: 0 }
	if (!body) return empty
	const ct = (contentType ?? '').toLowerCase()
	if (ct.includes('application/graphql')) {
		return { documents: [{ query: body }], persisted: 0 }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return empty
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed]
	const documents: { query: string; operationName?: string }[] = []
	let persisted = 0
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) continue
		const record = entry as Record<string, unknown>
		const query = record['query']
		const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : undefined
		if (typeof query === 'string' && query.trim()) {
			documents.push(operationName ? { query, operationName } : { query })
		} else if (hasPersistedQuery(record)) {
			persisted++
		}
	}
	return { documents, persisted }
}

/** An Apollo automatic-persisted-query request: a hash instead of the document. */
function hasPersistedQuery(record: Record<string, unknown>): boolean {
	const extensions = record['extensions']
	if (typeof extensions !== 'object' || extensions === null) return false
	return 'persistedQuery' in (extensions as Record<string, unknown>)
}

/**
 * Blank out comments and string literals so the structural scan below can't be
 * fooled by a `{`, `#` or `}` inside them. Characters are replaced 1:1 with
 * spaces, never removed, so every offset in the cleaned text still addresses the
 * same character of the original (the selection bodies we slice out come from
 * the cleaned text, which is fine — we only ever read names from them).
 */
function blankOutLiterals(text: string): string {
	const out = text.split('')
	let i = 0
	while (i < text.length) {
		const ch = text[i]
		if (ch === '#') {
			while (i < text.length && text[i] !== '\n') out[i++] = ' '
			continue
		}
		if (ch === '"') {
			const isBlock = text.startsWith('"""', i)
			const quote = isBlock ? '"""' : '"'
			let j = i + quote.length
			while (j < text.length) {
				if (!isBlock && text[j] === '\\') {
					j += 2
					continue
				}
				if (text.startsWith(quote, j)) {
					j += quote.length
					break
				}
				j++
			}
			for (let k = i; k < Math.min(j, text.length); k++) out[k] = ' '
			i = j
			continue
		}
		i++
	}
	return out.join('')
}

const NAME_START_RE = /[_A-Za-z]/
const NAME_RE = /[_0-9A-Za-z]/

/** Index of the next non-whitespace, non-comma character at or after `i`. */
function skipTrivia(text: string, i: number): number {
	while (i < text.length && (/\s/.test(text[i] as string) || text[i] === ',')) i++
	return i
}

/** Skip any `@directive(...)` sequence at `i`, returning the index after it. */
function skipDirectives(text: string, from: number): number {
	let i = skipTrivia(text, from)
	while (text[i] === '@') {
		const directive = readName(text, i + 1)
		i = skipTrivia(text, directive.next)
		if (text[i] === '(') i = skipTrivia(text, matchBlock(text, i, '(', ')'))
	}
	return i
}

/** Read a GraphQL name starting at `i`; returns the name and the index after it. */
function readName(text: string, i: number): { name: string; next: number } {
	let j = i
	while (j < text.length && NAME_RE.test(text[j] as string)) j++
	return { name: text.slice(i, j), next: j }
}

/**
 * Index just past the block that opens at `i` (`open`/`close` being its
 * delimiters). Returns `text.length` for an unterminated block — a truncated
 * document degrades to "fewer fields", never to a throw.
 */
function matchBlock(text: string, i: number, open: string, close: string): number {
	let depth = 0
	for (let j = i; j < text.length; j++) {
		if (text[j] === open) depth++
		else if (text[j] === close) {
			depth--
			if (depth === 0) return j + 1
		}
	}
	return text.length
}

interface GqlField {
	name: string
	/** The field's sub-selection body (without the braces), when it has one. */
	selection?: string
	/** Argument key paths, names only. */
	args?: string[]
}

/**
 * Argument object keys, as dotted paths — `by.id`, `filter.account.company.name.eq`.
 *
 * **Keys only, never values.** A filter's keys are relation names, which is a
 * dependency signal worth as much as the selection set: a query filtering on
 * `account.company.name` depends on `Company` whether or not it selects it. Its
 * *values* are tenant names, emails and search terms, and the footprint is
 * uploaded and rendered on a dashboard. String literals are already blanked out
 * by {@link blankOutLiterals} before this sees them, but the rule is enforced
 * here too rather than relying on that: this function only ever emits names.
 */
export function parseArgumentKeys(block: string): string[] {
	const out: string[] = []
	collectArgumentKeys(block, [], out)
	return out
}

function collectArgumentKeys(body: string, prefix: string[], out: string[]): void {
	if (prefix.length >= MAX_FIELD_DEPTH) return
	let i = 0
	while (i < body.length && out.length < MAX_FIELD_ARGS) {
		i = skipTrivia(body, i)
		if (i >= body.length) break
		if (!NAME_START_RE.test(body[i] as string)) {
			i++
			continue
		}
		const key = readName(body, i)
		i = skipTrivia(body, key.next)
		// Not a `key: value` pair — an enum member or a list element. Nothing to name.
		if (body[i] !== ':') continue
		i = skipTrivia(body, i + 1)
		const path = [...prefix, key.name]
		if (body[i] === '{') {
			const end = matchBlock(body, i, '{', '}')
			collectArgumentKeys(body.slice(i + 1, end - 1), path, out)
			i = end
			continue
		}
		if (body[i] === '[') {
			const end = matchBlock(body, i, '[', ']')
			// A list of objects (`or: [{ a: … }, { b: … }]`) contributes its keys at
			// this path; a list of scalars contributes only the key itself.
			const before = out.length
			collectArgumentKeys(body.slice(i + 1, end - 1), path, out)
			if (out.length === before) out.push(path.join('.'))
			i = end
			continue
		}
		out.push(path.join('.'))
		i = skipArgumentValue(body, i)
	}
}

/** Index just past a scalar/variable/enum argument value — up to the next comma at this level. */
function skipArgumentValue(body: string, from: number): number {
	let i = from
	while (i < body.length) {
		const ch = body[i] as string
		if (ch === ',') return i + 1
		if (ch === '{') {
			i = matchBlock(body, i, '{', '}')
			continue
		}
		if (ch === '[') {
			i = matchBlock(body, i, '[', ']')
			continue
		}
		if (ch === '(') {
			i = matchBlock(body, i, '(', ')')
			continue
		}
		i++
	}
	return i
}

/**
 * Parse one selection-set body into its fields, resolving aliases, skipping
 * arguments and directives, and splicing fragments in place — an inline fragment
 * (`... on Type { … }`) and a named spread (`...Fields`) both contribute their
 * fields at the level where they appear, which is exactly what "root fields"
 * must mean for a query that keeps its top level in a fragment.
 */
function parseSelectionSet(body: string, fragments: Map<string, string>, seen: Set<string> = new Set()): GqlField[] {
	const fields: GqlField[] = []
	let i = 0
	while (i < body.length) {
		i = skipTrivia(body, i)
		if (i >= body.length) break
		if (body.startsWith('...', i)) {
			i += 3
			i = skipTrivia(body, i)
			const { name, next } = readName(body, i)
			if (name === 'on') {
				// Inline fragment: `... on Type { … }` — its fields belong to this level.
				i = skipTrivia(body, next)
				const typeName = readName(body, i)
				i = skipTrivia(body, typeName.next)
				// A directive may sit between the type condition and the selection set
				// (`... on Query @include(if: $x) { … }`). Without skipping it, the
				// fragment body is missed and the DIRECTIVE's name is recorded as a
				// root field instead of the fields inside.
				i = skipDirectives(body, i)
				if (body[i] === '{') {
					const end = matchBlock(body, i, '{', '}')
					fields.push(...parseSelectionSet(body.slice(i + 1, end - 1), fragments, seen))
					i = end
				}
				continue
			}
			// A named spread can carry directives too: `...Fields @skip(if: $x)`.
			i = skipDirectives(body, skipTrivia(body, next))
			if (name && !seen.has(name)) {
				// Named spread: splice the fragment's own fields in, guarding against
				// a cyclic document (illegal GraphQL, but we must not hang on one).
				const fragmentBody = fragments.get(name)
				if (fragmentBody !== undefined) {
					const nested = new Set(seen)
					nested.add(name)
					fields.push(...parseSelectionSet(fragmentBody, fragments, nested))
				}
			}
			continue
		}
		if (!NAME_START_RE.test(body[i] as string)) {
			i++
			continue
		}
		const first = readName(body, i)
		let fieldName = first.name
		i = skipTrivia(body, first.next)
		if (body[i] === ':') {
			// It was an alias — the real field name follows.
			i = skipTrivia(body, i + 1)
			const actual = readName(body, i)
			fieldName = actual.name
			i = skipTrivia(body, actual.next)
		}
		let args: string[] | undefined
		if (body[i] === '(') {
			const end = matchBlock(body, i, '(', ')')
			args = parseArgumentKeys(body.slice(i + 1, end - 1))
			i = skipTrivia(body, end)
		}
		i = skipDirectives(body, i)
		let selection: string | undefined
		if (body[i] === '{') {
			const end = matchBlock(body, i, '{', '}')
			selection = body.slice(i + 1, end - 1)
			i = end
		}
		if (fieldName) {
			fields.push({
				name: fieldName,
				...(selection === undefined ? {} : { selection }),
				...(args && args.length > 0 ? { args } : {}),
			})
		}
	}
	return fields
}

/** Collect `fragment Name on Type { … }` definitions so spreads can be resolved. */
function collectFragments(text: string): Map<string, string> {
	const fragments = new Map<string, string>()
	const re = /\bfragment\s+([_A-Za-z][_0-9A-Za-z]*)\s+on\s+[_A-Za-z][_0-9A-Za-z]*/g
	let match: RegExpExecArray | null
	while ((match = re.exec(text)) !== null) {
		const braceStart = text.indexOf('{', match.index + match[0].length)
		if (braceStart === -1) continue
		const end = matchBlock(text, braceStart, '{', '}')
		fragments.set(match[1] as string, text.slice(braceStart + 1, end - 1))
	}
	return fragments
}

export interface ParseOptions {
	/** Only keep the operation the client selected (a document may define several). */
	operationName?: string
	/** Fields whose children are the real operations. Contributed by plugins (Contember: `transaction`). */
	transparentFields?: Iterable<string>
	/**
	 * Fields that never name a model, contributed by plugins on top of the
	 * built-in introspection set (Contember: `_info`, `ok`, `errorMessage`).
	 */
	ignoredRootFields?: Iterable<string>
}

/**
 * Parse a GraphQL document into its operations and their top-level fields.
 *
 * Tolerant by design: an unparseable or truncated document yields fewer
 * operations, never an exception. A footprint is best-effort telemetry — it must
 * not be able to fail a test.
 */
export function parseOperations(document: string, options: ParseOptions = {}): ParsedOperation[] {
	const text = blankOutLiterals(document)
	const fragments = collectFragments(text)
	const transparent = new Set(options.transparentFields ?? [])
	const ignored = new Set([...BUILTIN_IGNORED_FIELDS, ...(options.ignoredRootFields ?? [])])
	const operations: ParsedOperation[] = []
	let i = 0
	while (i < text.length) {
		i = skipTrivia(text, i)
		if (i >= text.length) break
		const ch = text[i] as string
		if (ch === '{') {
			// Anonymous shorthand query.
			const end = matchBlock(text, i, '{', '}')
			operations.push({ type: 'query', ...selectionOf(text.slice(i + 1, end - 1), fragments, transparent, ignored) })
			i = end
			continue
		}
		if (!NAME_START_RE.test(ch)) {
			i++
			continue
		}
		const keyword = readName(text, i)
		i = keyword.next
		if (keyword.name === 'fragment') {
			// Definitions are collected above; skip past this one's body.
			const braceStart = text.indexOf('{', i)
			i = braceStart === -1 ? text.length : matchBlock(text, braceStart, '{', '}')
			continue
		}
		if (keyword.name !== 'query' && keyword.name !== 'mutation' && keyword.name !== 'subscription') {
			continue
		}
		const type = keyword.name
		i = skipTrivia(text, i)
		let name: string | undefined
		if (NAME_START_RE.test(text[i] ?? '')) {
			const parsedName = readName(text, i)
			name = parsedName.name
			i = skipTrivia(text, parsedName.next)
		}
		// Variable definitions and directives sit between the name and the selection
		// set, and a variable's DEFAULT can itself be an object — `($f: F = {a: 1})`.
		// Searching for the next brace would find that default and read its contents
		// as the operation's root fields, so the parens are skipped as a block first.
		i = skipTrivia(text, i)
		if (text[i] === '(') i = skipTrivia(text, matchBlock(text, i, '(', ')'))
		while (text[i] === '@') {
			const directive = readName(text, i + 1)
			i = skipTrivia(text, directive.next)
			if (text[i] === '(') i = skipTrivia(text, matchBlock(text, i, '(', ')'))
		}
		const braceStart = text.indexOf('{', i)
		if (braceStart === -1) break
		const end = matchBlock(text, braceStart, '{', '}')
		operations.push({
			type,
			...(name ? { name } : {}),
			...selectionOf(text.slice(braceStart + 1, end - 1), fragments, transparent, ignored),
		})
		i = end
	}
	if (options.operationName && operations.length > 1) {
		const selected = operations.filter((op) => op.name === options.operationName)
		if (selected.length > 0) return selected
	}
	return operations
}

/** An operation's selection: the tree, plus the root field names derived from it. */
function selectionOf(
	body: string,
	fragments: Map<string, string>,
	transparent: Set<string>,
	ignored: Set<string>,
): { rootFields: string[]; fields: GqlFieldNode[]; truncated?: boolean } {
	const budget = { nodes: 0, truncated: false }
	const fields = buildTree(body, fragments, transparent, ignored, [], budget)
	return {
		rootFields: [...new Set(fields.map((field) => field.name))],
		fields,
		...(budget.truncated ? { truncated: true } : {}),
	}
}

/**
 * Build the selection tree, splicing fragments and unwrapping transparent
 * wrappers so a node's `path` is the path through the *schema*, not through the
 * document's plumbing.
 *
 * The node budget is charged only BELOW the top level. Root fields are what the
 * model derivation reads, and a document whose first field drags a 500-node
 * subtree behind it must not push a later root field out of the list — that
 * would lose a whole entity, where truncating depth only loses detail.
 */
function buildTree(
	body: string,
	fragments: Map<string, string>,
	transparent: Set<string>,
	ignored: Set<string>,
	parentPath: string[],
	budget: { nodes: number; truncated: boolean },
): GqlFieldNode[] {
	if (parentPath.length >= MAX_FIELD_DEPTH) {
		budget.truncated = true
		return []
	}
	const nodes: GqlFieldNode[] = []
	for (const field of parseSelectionSet(body, fragments)) {
		if (ignored.has(field.name)) continue
		if (transparent.has(field.name) && field.selection !== undefined) {
			// The wrapper contributes nothing itself; its children sit at ITS level.
			nodes.push(...buildTree(field.selection, fragments, transparent, ignored, parentPath, budget))
			continue
		}
		if (parentPath.length > 0) {
			if (budget.nodes >= MAX_FIELD_NODES) {
				budget.truncated = true
				break
			}
			budget.nodes++
		}
		const path = [...parentPath, field.name]
		const children = field.selection === undefined
			? []
			: buildTree(field.selection, fragments, transparent, ignored, path, budget)
		nodes.push({
			name: field.name,
			path,
			...(field.args && field.args.length > 0 ? { args: field.args } : {}),
			...(children.length > 0 ? { children } : {}),
		})
	}
	return nodes
}

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

/**
 * Does this request look like GraphQL? A path ending in `/graphql` is the
 * convention; a JSON body carrying a `query` string is the fallback for the
 * apps that mount it elsewhere (`/api`, `/v1/content`).
 */
export function looksLikeGraphql(pathname: string, body: string | undefined, contentType?: string): boolean {
	if (/\/graphql\b/i.test(pathname)) return true
	if ((contentType ?? '').toLowerCase().includes('application/graphql')) return true
	if (!body) return false
	// No size limit of its own. It used to stop at a megabyte, which quietly
	// answered "not GraphQL" for a body the COLLECTOR was willing to scan (its
	// limit is 2 MiB) — so such a request was neither parsed nor counted as
	// unreadable, and the models read as an authoritative empty set. One limit,
	// enforced in one place, is the only way those two agree.
	if (!body.includes('"query"') && !body.includes('"operationName"')) return false
	return /["']\s*(query|operationName)\s*["']\s*:/.test(body)
}
