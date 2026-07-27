import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileRoutes } from './file-routes.js'
import type { FootprintHooks, PluginContext, RequestObservation } from './types.js'

const CONTEXT: PluginContext = { scenario: 'a scenario', mode: 'network' }

const root = mkdtempSync(path.join(tmpdir(), 'opice-routes-'))
mkdirSync(path.join(root, 'flat'), { recursive: true })
writeFileSync(path.join(root, 'flat', 'api.invoices.$id.ts'), '')
writeFileSync(path.join(root, 'flat', 'api.health.ts'), '')
mkdirSync(path.join(root, 'nested', 'api', 'invoices'), { recursive: true })
writeFileSync(path.join(root, 'nested', 'api', 'invoices', '[id].ts'), '')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const request = (overrides: Partial<RequestObservation> = {}): RequestObservation => ({
	method: 'GET',
	route: '/api/invoices/:id',
	status: 200,
	resourceType: 'fetch',
	step: 0,
	...overrides,
})

async function hooks(dir: string, style: 'flat' | 'nested'): Promise<FootprintHooks> {
	const plugin = fileRoutes({ dir, style })
	return await plugin.bind!(CONTEXT)
}

describe('fileRoutes', () => {
	test('maps an API request to the flat route file that serves it', async () => {
		// The whole point: this request produces an `endpoint` edge no file change
		// ever matches. With the plugin, editing the route file selects the scenario.
		const resolved = (await hooks(`${root}/flat`, 'flat')).resolve?.(request(), CONTEXT)
		expect(resolved).toEqual([{ kind: 'file', path: `${root}/flat/api.invoices.$id.ts` }])
	})

	test('maps Next-style nested directories', async () => {
		const resolved = (await hooks(`${root}/nested`, 'nested')).resolve?.(request(), CONTEXT)
		expect(resolved).toEqual([{ kind: 'file', path: `${root}/nested/api/invoices/[id].ts` }])
	})

	test('claims nothing when no such route file exists', async () => {
		// Built on the file listing rather than a naming heuristic, so a wrong guess
		// produces no edge instead of a phantom one.
		const resolved = (await hooks(`${root}/flat`, 'flat')).resolve?.(request({ route: '/api/unknown' }), CONTEXT)
		expect(resolved).toEqual([])
	})

	test('ignores third-party traffic and document navigation', async () => {
		const chain = await hooks(`${root}/flat`, 'flat')
		// Origin-qualified: this repo does not serve analytics.
		expect(chain.resolve?.(request({ route: 'https://analytics.test/collect' }), CONTEXT)).toEqual([])
		// The SPA shell — the module and coverage collectors speak for the client side.
		expect(chain.resolve?.(request({ route: '/api/health', resourceType: 'document' }), CONTEXT)).toEqual([])
	})

	test('a missing routes directory yields nothing rather than throwing', async () => {
		const chain = await hooks(`${root}/does-not-exist`, 'flat')
		expect(chain.resolve?.(request(), CONTEXT)).toEqual([])
	})
})
