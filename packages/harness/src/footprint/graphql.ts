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
}

/**
 * Root fields that are pure plumbing: their *children* are the real operations.
 * Contember wraps every mutation in `transaction { … }`, so without unwrapping,
 * every write in a Contember app would report the single model "transaction".
 */
const DEFAULT_TRANSPARENT_FIELDS = new Set(['transaction'])

/** Introspection + meta fields — never models. */
const IGNORED_ROOT_FIELDS = new Set(['__schema', '__type', '__typename', '_info', 'query', 'ok', 'errorMessage'])

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
				if (body[i] === '{') {
					const end = matchBlock(body, i, '{', '}')
					fields.push(...parseSelectionSet(body.slice(i + 1, end - 1), fragments, seen))
					i = end
				}
				continue
			}
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
			i = next
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
		if (body[i] === '(') {
			i = skipTrivia(body, matchBlock(body, i, '(', ')'))
		}
		while (body[i] === '@') {
			const directive = readName(body, i + 1)
			i = skipTrivia(body, directive.next)
			if (body[i] === '(') i = skipTrivia(body, matchBlock(body, i, '(', ')'))
		}
		let selection: string | undefined
		if (body[i] === '{') {
			const end = matchBlock(body, i, '{', '}')
			selection = body.slice(i + 1, end - 1)
			i = end
		}
		if (fieldName) fields.push(selection === undefined ? { name: fieldName } : { name: fieldName, selection })
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
	/** Fields whose children are the real operations. Defaults to `transaction`. */
	transparentFields?: Iterable<string>
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
	const transparent = options.transparentFields ? new Set(options.transparentFields) : DEFAULT_TRANSPARENT_FIELDS
	const operations: ParsedOperation[] = []
	let i = 0
	while (i < text.length) {
		i = skipTrivia(text, i)
		if (i >= text.length) break
		const ch = text[i] as string
		if (ch === '{') {
			// Anonymous shorthand query.
			const end = matchBlock(text, i, '{', '}')
			operations.push({ type: 'query', rootFields: rootFieldsOf(text.slice(i + 1, end - 1), fragments, transparent) })
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
		// Variable definitions + directives sit between the name and the selection set.
		const braceStart = text.indexOf('{', i)
		if (braceStart === -1) break
		const end = matchBlock(text, braceStart, '{', '}')
		operations.push({
			type,
			...(name ? { name } : {}),
			rootFields: rootFieldsOf(text.slice(braceStart + 1, end - 1), fragments, transparent),
		})
		i = end
	}
	if (options.operationName && operations.length > 1) {
		const selected = operations.filter((op) => op.name === options.operationName)
		if (selected.length > 0) return selected
	}
	return operations
}

/** Top-level field names of a selection body, with transparent wrappers unwrapped. */
function rootFieldsOf(body: string, fragments: Map<string, string>, transparent: Set<string>): string[] {
	const out: string[] = []
	for (const field of parseSelectionSet(body, fragments)) {
		if (IGNORED_ROOT_FIELDS.has(field.name)) continue
		if (transparent.has(field.name) && field.selection !== undefined) {
			for (const inner of parseSelectionSet(field.selection, fragments)) {
				if (!IGNORED_ROOT_FIELDS.has(inner.name)) out.push(inner.name)
			}
			continue
		}
		out.push(field.name)
	}
	return [...new Set(out)]
}

/**
 * Root-field verbs that name an entity. Contember generates
 * `list|get|paginate + Entity` for reads and `create|update|delete|upsert +
 * Entity` for writes; the same convention covers most hand-written schemas
 * (`createUser`, `updateInvoice`, `deleteComment`).
 */
const READ_VERBS = ['list', 'get', 'paginate', 'find', 'fetch', 'search']
const WRITE_VERBS = ['create', 'update', 'delete', 'upsert', 'remove', 'add', 'set', 'save']
const VERB_RE = new RegExp(`^(${[...READ_VERBS, ...WRITE_VERBS].join('|')})([A-Z][A-Za-z0-9_]*)$`)
const WRITE_SET = new Set(WRITE_VERBS)

/**
 * Derive the models an operation touches from its root fields.
 *
 * The built-in heuristic only claims a model when the field follows the
 * verb+Entity convention — a field it can't read (`viewer`, `me`, `node`) yields
 * NO model rather than a guessed one. That's deliberate: a wrong model on the
 * dashboard is worse than a missing one, and a repo whose schema doesn't follow
 * the convention can supply an exact `mapOperation` in `browser-footprint.ts`.
 * The raw `rootFields` are always reported either way, so nothing is lost.
 */
export function deriveModels(operation: ParsedOperation): FootprintModel[] {
	const byName = new Map<string, boolean>()
	for (const field of operation.rootFields) {
		const match = VERB_RE.exec(field)
		if (!match) continue
		const verb = match[1] as string
		const entity = match[2] as string
		// A mutation's reads are still writes in effect — the operation as a whole
		// changes state — but the verb is the sharper signal, so it wins.
		const write = WRITE_SET.has(verb) || operation.type === 'mutation'
		byName.set(entity, (byName.get(entity) ?? false) || write)
	}
	return [...byName].map(([name, write]) => ({ name, write }))
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
	if (!body || body.length > 1_000_000) return false
	if (!body.includes('"query"') && !body.includes('"operationName"')) return false
	return /["']\s*(query|operationName)\s*["']\s*:/.test(body)
}
