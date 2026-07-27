import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseOperations } from '../graphql.js'
import { contemberSchema, readEntityGraph } from './contember-schema.js'
import type { Dependency, FootprintHooks, PluginContext } from './types.js'

const CONTEXT: PluginContext = { scenario: 'a scenario', mode: 'network' }

// A schema in the shape a real Contember repo has it: kebab-case files, one
// `export class` each, relations pointing at classes defined elsewhere.
const root = mkdtempSync(path.join(tmpdir(), 'opice-schema-'))
mkdirSync(path.join(root, 'model', 'edu'), { recursive: true })
const write = (file: string, source: string) => writeFileSync(path.join(root, 'model', file), source)

write('supplier-invoice.ts', `
	import { c } from '@contember/schema-definition'
	import { Contract } from './contract'
	/** A supplier invoice. Comment with a stray { brace to trip a naive scanner. */
	export class SupplierInvoice {
		supplier = c.stringColumn().notNull()
		linkedContract = c.manyHasOne(Contract).setNullOnDelete()
	}
`)
write('contract.ts', `
	import { c } from '@contember/schema-definition'
	import { Organization } from './edu/organization'
	import { ContractAttachment } from './contract-attachment'
	export const ContractLifecycleState = c.createEnum('active', 'expired')
	export class Contract {
		code = c.stringColumn().notNull().default('{ not a brace }')
		counterpartyOrganization = c.manyHasOne(Organization, 'contracts').notNull().restrictOnDelete()
		attachments = c.oneHasMany(ContractAttachment, 'contract')
	}
`)
write('contract-attachment.ts', `
	import { c } from '@contember/schema-definition'
	export class ContractAttachment { name = c.stringColumn() }
`)
write(path.join('edu', 'organization.ts'), `
	import { c } from '@contember/schema-definition'
	export class Organization { name = c.stringColumn() }
`)

afterAll(() => rmSync(root, { recursive: true, force: true }))

const dir = path.join(root, 'model')

async function resolve(document: string): Promise<Dependency[]> {
	const plugin = contemberSchema({ dir })
	const hooks: FootprintHooks = await plugin.bind!(CONTEXT)
	return hooks.resolve?.({
		method: 'POST',
		route: '/content/app/live',
		status: 200,
		resourceType: 'fetch',
		step: 0,
		graphql: parseOperations(document, { transparentFields: ['transaction'], ignoredRootFields: ['ok', 'errorMessage'] }),
	}, CONTEXT) ?? []
}

const models = (deps: Dependency[]) => deps.filter((d) => d.kind === 'model').map((d) => (d as { name: string }).name)
const files = (deps: Dependency[]) => deps.filter((d) => d.kind === 'file').map((d) => (d as { path: string }).path.slice(dir.length + 1))

describe('readEntityGraph', () => {
	test('reads entities and their relation targets across directories', () => {
		const entities = readEntityGraph([dir])
		expect([...entities.keys()].sort()).toEqual(['Contract', 'ContractAttachment', 'Organization', 'SupplierInvoice'])
		expect(entities.get('Contract')?.relations.get('counterpartyOrganization')).toBe('Organization')
		expect(entities.get('Contract')?.relations.get('attachments')).toBe('ContractAttachment')
		// A brace inside a comment or a string literal must not end the class body.
		expect(entities.get('Contract')?.relations.size).toBe(2)
	})

	test('a missing directory yields an empty graph rather than throwing', () => {
		expect(readEntityGraph([path.join(root, 'nope')]).size).toBe(0)
	})
})

describe('contemberSchema', () => {
	test('walks a nested selection into the entities the built-in derivation cannot see', async () => {
		// The real query from a client repo. Built-in derivation reports one model.
		const deps = await resolve(
			'query { listSupplierInvoice { supplier linkedContract { counterpartyOrganization { name } } } }',
		)
		expect(models(deps)).toEqual(['SupplierInvoice', 'Contract', 'Organization'])
	})

	test('names the defining FILE, which is what a diff actually matches', async () => {
		// The better half: a model edge `SupplierInvoice` only reaches a changed path
		// through a name heuristic, and `supplier-invoice.ts` differs by more than case.
		const deps = await resolve('query { listSupplierInvoice { linkedContract { code } } }')
		expect(files(deps)).toEqual(['supplier-invoice.ts', 'contract.ts'])
	})

	test('resolves relation names inside a filter argument', async () => {
		// A query that filters on a relation depends on it as surely as one that
		// selects it — and the argument is the only place that dependency appears.
		const deps = await resolve(
			'query { listSupplierInvoice(filter: { linkedContract: { counterpartyOrganization: { name: { eq: "acme" } } } }) { id } }',
		)
		expect(models(deps)).toEqual(['SupplierInvoice', 'Contract', 'Organization'])
	})

	test('walks through a mutation payload wrapper', async () => {
		const deps = await resolve(
			'mutation { transaction { createSupplierInvoice(data: {}) { ok node { linkedContract { code } } } } }',
		)
		expect(models(deps)).toEqual(['SupplierInvoice', 'Contract'])
		expect(deps.find((d) => d.kind === 'model')).toMatchObject({ name: 'SupplierInvoice', write: true })
	})

	test('a nested read inside a mutation is still a read', async () => {
		const deps = await resolve('mutation { createSupplierInvoice(data: {}) { node { linkedContract { code } } } }')
		expect(deps.filter((d) => d.kind === 'model')).toEqual([
			{ kind: 'model', name: 'SupplierInvoice', write: true },
			{ kind: 'model', name: 'Contract', write: false },
		])
	})

	test('claims nothing for a field the schema does not have', async () => {
		// The whole safety property: an unknown segment resolves to nothing rather
		// than to an entity guessed from its name.
		expect(models(await resolve('query { listSupplierInvoice { unknownRelation { id } } }'))).toEqual(['SupplierInvoice'])
		expect(models(await resolve('query { me { id } }'))).toEqual([])
		expect(models(await resolve('query { listNoSuchEntity { id } }'))).toEqual([])
	})

	test('a scalar column is not a relation', async () => {
		expect(models(await resolve('query { listSupplierInvoice { supplier } }'))).toEqual(['SupplierInvoice'])
	})

	test('files can be switched off, leaving only the model names', async () => {
		const plugin = contemberSchema({ dir, files: false })
		const hooks: FootprintHooks = await plugin.bind!(CONTEXT)
		const deps = hooks.resolve?.({
			method: 'POST',
			route: '/content/app/live',
			status: 200,
			resourceType: 'fetch',
			step: 0,
			graphql: parseOperations('query { listSupplierInvoice { linkedContract { code } } }'),
		}, CONTEXT) ?? []
		expect(files(deps)).toEqual([])
		expect(models(deps)).toEqual(['SupplierInvoice', 'Contract'])
	})

	test('a request carrying no GraphQL resolves nothing', async () => {
		const plugin = contemberSchema({ dir })
		const hooks: FootprintHooks = await plugin.bind!(CONTEXT)
		expect(hooks.resolve?.({ method: 'GET', route: '/api/x', status: 200, resourceType: 'fetch', step: 0 }, CONTEXT)).toEqual([])
	})
})
