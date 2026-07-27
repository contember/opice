import { describe, expect, test } from 'bun:test'
import { PluginChain } from './chain.js'
import type { FootprintPlugin, PluginContext } from './types.js'

const CONTEXT: PluginContext = { scenario: 'a scenario', mode: 'full' }

const plugin = (name: string, overrides: Partial<FootprintPlugin>): FootprintPlugin => ({ name, ...overrides })

describe('PluginChain', () => {
	test('route is first-wins, and a plugin that answers stops the chain', async () => {
		const chain = await PluginChain.bind([
			plugin('first', { bind: () => ({ route: (url) => (url.includes('/a/') ? '/a/:x' : undefined) }) }),
			plugin('second', { bind: () => ({ route: () => '/fallback' }) }),
		], CONTEXT)
		expect(chain.route('https://app.test/a/1')).toBe('/a/:x')
		expect(chain.route('https://app.test/b/1')).toBe('/fallback')
	})

	test('segment is a disjunction — one plugin wanting redaction is enough', async () => {
		const chain = await PluginChain.bind([
			plugin('never', { bind: () => ({ segment: () => false }) }),
			plugin('sometimes', { bind: () => ({ segment: (segment) => segment === 'acme' }) }),
		], CONTEXT)
		expect(chain.segment('acme', 1, ['customers', 'acme'])).toBe(true)
		expect(chain.segment('billing', 1, ['settings', 'billing'])).toBe(false)
	})

	test('resolve collects from every plugin, not just the first', async () => {
		const chain = await PluginChain.bind([
			plugin('files', { bind: () => ({ resolve: () => [{ kind: 'file', path: 'app/routes/a.ts' }] }) }),
			plugin('models', { bind: () => ({ resolve: () => [{ kind: 'model', name: 'Invoice', write: true }] }) }),
		], CONTEXT)
		expect(chain.resolve({ method: 'GET', route: '/a', status: 200, resourceType: 'fetch', step: 0 })).toEqual([
			{ kind: 'file', path: 'app/routes/a.ts' },
			{ kind: 'model', name: 'Invoice', write: true },
		])
	})

	test('a hook that throws is skipped, the chain continues, and its dimensions degrade', async () => {
		const chain = await PluginChain.bind([
			plugin('broken', {
				dimensions: ['models'],
				bind: () => ({ route: () => { throw new Error('boom') } }),
			}),
			plugin('working', { bind: () => ({ route: () => '/still/here' }) }),
		], CONTEXT)
		expect(chain.route('https://app.test/x')).toBe('/still/here')
		// Not "collected and empty" — partial refuses to replace edges, empty deletes them.
		expect([...chain.degraded]).toEqual(['models'])
		expect([...chain.warnings][0]).toContain(`plugin 'broken' threw in its route hook`)
	})

	test('warns once per plugin and hook, however many calls hit it', async () => {
		const chain = await PluginChain.bind([
			plugin('noisy', { bind: () => ({ route: () => { throw new Error('boom') } }) }),
		], CONTEXT)
		for (let i = 0; i < 50; i++) chain.route(`https://app.test/${i}`)
		expect(chain.warnings.size).toBe(1)
	})

	test('a throwing segment hook redacts rather than keeping the segment', async () => {
		// The one seam where a throw is not "skip and carry on": `:id` is the side
		// that cannot leak, and the predicate was asked precisely whether this
		// segment is safe to keep.
		const chain = await PluginChain.bind([
			plugin('broken', { bind: () => ({ segment: () => { throw new Error('boom') } }) }),
		], CONTEXT)
		expect(chain.segment('acme', 1, ['customers', 'acme'])).toBe(true)
	})

	test('a plugin whose bind throws is disabled and degrades its declared dimensions', async () => {
		const chain = await PluginChain.bind([
			plugin('broken', {
				dimensions: ['files'],
				bind: () => { throw new Error('cannot read schema') },
			}),
		], CONTEXT)
		expect(chain.has('resolve')).toBe(false)
		expect([...chain.degraded]).toEqual(['files'])
		expect([...chain.warnings][0]).toContain('failed to start')
	})

	test('a plugin with no declared dimensions degrades all four', async () => {
		const chain = await PluginChain.bind([
			plugin('broken', { bind: () => { throw new Error('boom') } }),
		], CONTEXT)
		expect([...chain.degraded].sort()).toEqual(['components', 'endpoints', 'files', 'models'])
	})

	test('conventions are unioned across plugins, not overridden', async () => {
		// Two plugins both naming a transparent wrapper is the normal case; "last
		// one wins" would silently disarm the first.
		const merged = PluginChain.conventions([
			plugin('a', { graphql: { transparentFields: ['transaction'], readVerbs: ['load'] } }),
			plugin('b', { graphql: { transparentFields: ['batch'] } }),
		])
		expect(merged.transparentFields).toEqual(['transaction', 'batch'])
		expect(merged.readVerbs).toEqual(['load'])
	})

	test('a plugin that contributes only conventions needs no bind', async () => {
		const chain = await PluginChain.bind([plugin('data-only', { graphql: { ignoredRootFields: ['ok'] } })], CONTEXT)
		expect(chain.degraded.size).toBe(0)
		expect(chain.has('route')).toBe(false)
	})
})

describe('PluginChain.degradeAll', () => {
	test('degrades every dimension the bound plugins speak for', async () => {
		// Used when the collector stops taking dependencies before the plugins stop
		// producing them: a dropped one could have been a file or a model.
		const chain = await PluginChain.bind([
			plugin('files', { dimensions: ['files'], bind: () => ({ resolve: () => [] }) }),
			plugin('models', { dimensions: ['models'], bind: () => ({ resolve: () => [] }) }),
		], CONTEXT)
		chain.degradeAll('capped')
		expect([...chain.degraded].sort()).toEqual(['files', 'models'])
		expect([...chain.warnings]).toEqual(['capped'])
	})
})
