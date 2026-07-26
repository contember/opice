import { describe, expect, test } from 'bun:test'
import { deriveModels, extractQueries, looksLikeGraphql, parseOperations } from './graphql.js'

describe('parseOperations', () => {
	test('reads a named query and its root fields', () => {
		const ops = parseOperations(`query InvoiceList($limit: Int) { listInvoice(limit: $limit) { id total } }`)
		expect(ops).toEqual([{ type: 'query', name: 'InvoiceList', rootFields: ['listInvoice'] }])
	})

	test('reads an anonymous shorthand query', () => {
		const ops = parseOperations(`{ me { id } }`)
		expect(ops).toEqual([{ type: 'query', rootFields: ['me'] }])
	})

	test('resolves aliases to the underlying field name', () => {
		const ops = parseOperations(`query { open: listInvoice(filter: {paid: false}) { id } }`)
		expect(ops[0]?.rootFields).toEqual(['listInvoice'])
	})

	test('unwraps a Contember transaction so writes name real entities', () => {
		const ops = parseOperations(`
			mutation Pay($id: UUID!) {
				transaction {
					updateInvoice(by: {id: $id}, data: {paid: true}) { ok }
					createPayment(data: {invoice: {connect: {id: $id}}}) { ok }
				}
			}
		`)
		expect(ops[0]?.type).toBe('mutation')
		expect(ops[0]?.rootFields).toEqual(['updateInvoice', 'createPayment'])
	})

	test('splices named fragments in at the level they appear', () => {
		const ops = parseOperations(`
			query Dashboard { ...Header ...Body }
			fragment Header on Query { getUser(by: {id: 1}) { name } }
			fragment Body on Query { listInvoice { id } }
		`)
		expect(ops).toHaveLength(1)
		expect(ops[0]?.rootFields).toEqual(['getUser', 'listInvoice'])
	})

	test('skips a directive on an inline fragment', () => {
		// Without skipping it, the fragment body is missed and `include` is recorded
		// as the root field instead of what's inside.
		const ops = parseOperations('query { ... on Query @include(if: true) { listUser { id } } }')
		expect(ops[0]?.rootFields).toEqual(['listUser'])
	})

	test('skips a directive on a named spread', () => {
		const ops = parseOperations('query Q { ...Fields @skip(if: false) } fragment Fields on Query { listInvoice { id } }')
		expect(ops[0]?.rootFields).toEqual(['listInvoice'])
	})

	test('splices inline fragments too', () => {
		const ops = parseOperations(`query { ... on Query { listArticle { id } } }`)
		expect(ops[0]?.rootFields).toEqual(['listArticle'])
	})

	test('survives braces and hashes inside strings and comments', () => {
		const ops = parseOperations(`
			# a comment with { braces } and a "quote
			query Search {
				listArticle(filter: {title: {eq: "a } b # c"}}) { id }
			}
		`)
		expect(ops[0]?.rootFields).toEqual(['listArticle'])
	})

	test('handles block strings', () => {
		const ops = parseOperations(`query { createNote(data: {body: """line } one\nline # two"""}) { ok } }`)
		expect(ops[0]?.rootFields).toEqual(['createNote'])
	})

	test('skips fragment definitions as operations', () => {
		const ops = parseOperations(`fragment F on Invoice { id } query Q { listInvoice { ...F } }`)
		expect(ops).toHaveLength(1)
		expect(ops[0]?.name).toBe('Q')
	})

	test('picks the selected operation out of a multi-operation document', () => {
		const doc = `query A { listInvoice { id } } query B { listArticle { id } }`
		expect(parseOperations(doc, { operationName: 'B' })).toEqual([{ type: 'query', name: 'B', rootFields: ['listArticle'] }])
		expect(parseOperations(doc)).toHaveLength(2)
	})

	test('does not hang on a cyclic fragment', () => {
		const ops = parseOperations(`query Q { ...A } fragment A on Query { ...B } fragment B on Query { ...A getUser { id } }`)
		expect(ops[0]?.rootFields).toEqual(['getUser'])
	})

	test('ignores introspection fields', () => {
		expect(parseOperations(`query { __schema { types { name } } }`)[0]?.rootFields).toEqual([])
	})

	test('is not fooled by an object-valued variable default', () => {
		// Searching for the next brace would find the default's, and read `active`
		// as the operation's root field.
		const ops = parseOperations('query Q($filter: Filter = {active: true}) { listInvoice { id } }')
		expect(ops).toEqual([{ type: 'query', name: 'Q', rootFields: ['listInvoice'] }])
	})

	test('skips directives between the variables and the selection set', () => {
		const ops = parseOperations('query Q($id: ID = {a: 1}) @cached(ttl: 60) { getUser { id } }')
		expect(ops[0]?.rootFields).toEqual(['getUser'])
	})

	test('an object default does not lose the operation under operationName', () => {
		const doc = 'query Q($f: F = {a: {b: 1}}) { listArticle { id } }'
		expect(parseOperations(doc, { operationName: 'Q' })[0]?.rootFields).toEqual(['listArticle'])
	})

	test('degrades rather than throwing on a truncated document', () => {
		expect(() => parseOperations(`query Broken { listInvoice { id `)).not.toThrow()
	})
})

describe('deriveModels', () => {
	test('splits reads from writes by verb', () => {
		expect(deriveModels({ type: 'query', rootFields: ['listInvoice', 'getUser'] })).toEqual([
			{ name: 'Invoice', write: false },
			{ name: 'User', write: false },
		])
		expect(deriveModels({ type: 'mutation', rootFields: ['updateInvoice'] })).toEqual([{ name: 'Invoice', write: true }])
	})

	test('a model both read and written in one operation is a write', () => {
		expect(deriveModels({ type: 'mutation', rootFields: ['getInvoice', 'updateInvoice'] })).toEqual([{ name: 'Invoice', write: true }])
	})

	test('claims no model for a field that does not follow the convention', () => {
		expect(deriveModels({ type: 'query', rootFields: ['me', 'viewer', 'node'] })).toEqual([])
	})

	// Root-field names below are taken verbatim from a generated Contember content
	// API schema, not invented — this is the naming the heuristic exists to read.
	test('reads a real Contember query root', () => {
		expect(deriveModels({
			type: 'query',
			rootFields: ['getContentBlock', 'listContentBlock', 'paginateContentBlock', 'getImage', 'schema', 's'],
		})).toEqual([
			{ name: 'ContentBlock', write: false },
			{ name: 'Image', write: false },
		])
	})

	test('reads a real Contember mutation root', () => {
		expect(deriveModels({
			type: 'mutation',
			rootFields: ['createContentBlock', 'upsertLink', 'deleteImage', 'generateUploadUrl'],
		})).toEqual([
			{ name: 'ContentBlock', write: true },
			{ name: 'Link', write: true },
			{ name: 'Image', write: true },
		])
	})

	test('unwraps validateCreate/validateUpdate to the entity, as a read', () => {
		// Naively this parses as the verb `validate` on an entity `CreateContentBlock`.
		expect(deriveModels({
			type: 'query',
			rootFields: ['validateCreateContentBlock', 'validateUpdateImage'],
		})).toEqual([
			{ name: 'ContentBlock', write: false },
			{ name: 'Image', write: false },
		])
	})

	test('a validation alongside a real write still reports the write', () => {
		expect(deriveModels({ type: 'mutation', rootFields: ['validateCreateImage', 'createImage'] }))
			.toEqual([{ name: 'Image', write: true }])
	})
})

describe('privacy', () => {
	// A footprint is uploaded to the platform and rendered on a dashboard. The
	// request body it is parsed from is where the passwords, tokens and personal
	// data live, so "only names come out of here" is a security property, not a
	// tidiness preference.
	test('no literal argument or variable value survives parsing', () => {
		const document = `
			mutation Login($password: String!) {
				transaction {
					createSession(data: { email: "person@example.com", password: $password, token: "sk-live-abcdef" }) { ok }
				}
			}
		`
		const serialized = JSON.stringify(parseOperations(document).map((op) => ({ op, models: deriveModels(op) })))
		expect(serialized).not.toContain('person@example.com')
		expect(serialized).not.toContain('sk-live-abcdef')
		expect(serialized).not.toContain('$password')
		// The names it IS meant to keep are still there.
		expect(serialized).toContain('createSession')
		expect(serialized).toContain('Login')
	})
})

describe('extractQueries', () => {
	test('reads a single JSON body', () => {
		const out = extractQueries(JSON.stringify({ query: '{ me { id } }', operationName: 'Me' }), 'application/json')
		expect(out.documents).toEqual([{ query: '{ me { id } }', operationName: 'Me' }])
	})

	test('reads a batched array body', () => {
		const out = extractQueries(JSON.stringify([{ query: 'query A { a }' }, { query: 'query B { b }' }]))
		expect(out.documents).toHaveLength(2)
	})

	test('reads a raw application/graphql body', () => {
		expect(extractQueries('{ me { id } }', 'application/graphql').documents).toEqual([{ query: '{ me { id } }' }])
	})

	test('counts persisted queries instead of reporting them as empty', () => {
		const out = extractQueries(JSON.stringify({ extensions: { persistedQuery: { sha256Hash: 'abc' } } }))
		expect(out).toEqual({ documents: [], persisted: 1 })
	})

	test('ignores a non-JSON body', () => {
		expect(extractQueries('not json', 'application/json').documents).toEqual([])
	})
})

describe('looksLikeGraphql', () => {
	test('matches by path', () => {
		expect(looksLikeGraphql('/graphql', undefined)).toBe(true)
		expect(looksLikeGraphql('/content/graphql/live', undefined)).toBe(true)
	})

	test('matches a json body carrying a query', () => {
		expect(looksLikeGraphql('/api', JSON.stringify({ query: '{ me { id } }' }))).toBe(true)
	})

	test('does not match ordinary REST traffic', () => {
		expect(looksLikeGraphql('/api/invoices', JSON.stringify({ total: 10 }))).toBe(false)
	})
})

describe('looksLikeGraphql body size', () => {
	// It used to stop at a megabyte and answer "not GraphQL" for a body the
	// collector was willing to scan, so the request was neither parsed nor
	// counted as unreadable — and the models read as an authoritative empty set.
	test('recognises a large JSON body on a non-/graphql path', () => {
		const padding = 'x'.repeat(1_200_000)
		const body = JSON.stringify({ query: '{ orders { id } }', variables: { padding } })
		expect(body.length).toBeGreaterThan(1_000_000)
		expect(looksLikeGraphql('/api/content', body)).toBe(true)
	})

	test('still rejects a large body that is not GraphQL', () => {
		expect(looksLikeGraphql('/api/upload', JSON.stringify({ blob: 'y'.repeat(1_200_000) }))).toBe(false)
	})

	test('a /graphql path needs no body at all', () => {
		expect(looksLikeGraphql('/graphql', undefined)).toBe(true)
	})
})
