import { describe, expect, test } from 'bun:test'
import { deriveModels, parseOperations } from '../graphql.js'
import { PluginChain } from './chain.js'
import { contember } from './contember.js'
import type { PluginContext } from './types.js'

const CONTEXT: PluginContext = { scenario: 'a scenario', mode: 'full' }

/** Wire the plugin the way the collector does: conventions into the parser, the model hook into the derivation. */
async function derive(document: string) {
	const plugins = [contember()]
	const chain = await PluginChain.bind(plugins, CONTEXT)
	const conventions = PluginChain.conventions(plugins)
	return parseOperations(document, conventions).map((operation) => ({
		rootFields: operation.rootFields,
		models: deriveModels(operation, {
			readVerbs: conventions.readVerbs,
			writeVerbs: conventions.writeVerbs,
			field: (node) => chain.model(node, operation),
		}),
	}))
}

describe('contember plugin', () => {
	test('unwraps the transaction wrapper so writes name real entities', async () => {
		// Without this, every write in a Contember app reports one model called
		// "transaction".
		const [operation] = await derive(`
			mutation Pay($id: UUID!) {
				transaction {
					updateInvoice(by: {id: $id}, data: {paid: true}) { ok }
					createPayment(data: {invoice: {connect: {id: $id}}}) { ok errorMessage }
				}
			}
		`)
		expect(operation?.rootFields).toEqual(['updateInvoice', 'createPayment'])
		expect(operation?.models).toEqual([
			{ name: 'Invoice', write: true },
			{ name: 'Payment', write: true },
		])
	})

	test('resolves validateCreateX to the entity, as a read', async () => {
		// Naively this is the verb `validate` on an entity called `CreateImage`,
		// which is not a thing. Validating is the operation that promises not to write.
		const [operation] = await derive(`query { validateCreateImage(data: {}) { valid } }`)
		expect(operation?.models).toEqual([{ name: 'Image', write: false }])
	})

	test('a validation alongside a real write still reports the write', async () => {
		const [operation] = await derive(`
			mutation { transaction { validateCreateImage(data: {}) { valid } createImage(data: {}) { ok } } }
		`)
		expect(operation?.models).toEqual([{ name: 'Image', write: true }])
	})

	test('mutation result fields never become entities', async () => {
		const [operation] = await derive(`mutation { transaction { createImage(data: {}) { ok errorMessage } } }`)
		expect(operation?.rootFields).toEqual(['createImage'])
		expect(operation?.models).toEqual([{ name: 'Image', write: true }])
	})

	test('the conventions are removable — without the plugin, none of them apply', () => {
		// The point of moving them out of the parser: a repo that isn't Contember
		// can drop them, which was impossible when they were module constants.
		const [operation] = parseOperations(`mutation { transaction { createImage(data: {}) { ok } } }`)
		expect(operation?.rootFields).toEqual(['transaction'])
	})
})
