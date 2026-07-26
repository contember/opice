import { describe, expect, test } from 'bun:test'
import { aggregateEndpoints, aggregateModels } from './collector.js'
import { resolveSourcePath } from './coverage.js'
import { moduleUrlToSourcePath, normalizeSourceMapPath } from './modules.js'
import type { FootprintRequest } from './types.js'

const APP = 'http://localhost:15180'

describe('moduleUrlToSourcePath', () => {
	test('reads a dev-server module URL as its source path', () => {
		expect(moduleUrlToSourcePath(`${APP}/src/components/InvoiceForm.tsx`)).toEqual({
			path: 'src/components/InvoiceForm.tsx',
			bundled: false,
		})
	})

	test('ignores the version query a dev server appends', () => {
		expect(moduleUrlToSourcePath(`${APP}/src/App.tsx?t=1718000000000`).path).toBe('src/App.tsx')
	})

	test('keeps stylesheets — a changed stylesheet is a real change', () => {
		expect(moduleUrlToSourcePath(`${APP}/src/styles.css`).path).toBe('src/styles.css')
	})

	test('drops tooling and vendor code', () => {
		expect(moduleUrlToSourcePath(`${APP}/@vite/client`).path).toBeNull()
		expect(moduleUrlToSourcePath(`${APP}/node_modules/.vite/deps/react.js`).path).toBeNull()
		expect(moduleUrlToSourcePath(`${APP}/@react-refresh`).path).toBeNull()
	})

	test('flags a hashed production chunk instead of reporting it as a file', () => {
		expect(moduleUrlToSourcePath(`${APP}/assets/index-a1b2c3d4.js`)).toEqual({ path: null, bundled: true })
		// Vite's hashes are base64url-ish, not hex — matching hex alone let these
		// through as if they were source files.
		expect(moduleUrlToSourcePath(`${APP}/assets/index-C9nUJBE7.js`)).toEqual({ path: null, bundled: true })
		expect(moduleUrlToSourcePath(`${APP}/assets/main-BxT2_9qK.css`)).toEqual({ path: null, bundled: true })
	})

	test('a long descriptive filename is not a build hash', () => {
		// Length alone said "hashed", which cost this stylesheet its file edge —
		// changing it could then select nothing.
		expect(moduleUrlToSourcePath(`${APP}/src/admin-dashboard.css`).path).toBe('src/admin-dashboard.css')
		expect(moduleUrlToSourcePath(`${APP}/src/notifications.js`).path).toBe('src/notifications.js')
	})

	test('decodes percent-encoded source paths', () => {
		// git reports the path decoded, so an encoded one would match nothing.
		expect(moduleUrlToSourcePath(`${APP}/src/My%20Panel.tsx`).path).toBe('src/My Panel.tsx')
	})

	test('applies sourceRoot for a dev server rooted below the repo root', () => {
		expect(moduleUrlToSourcePath(`${APP}/src/App.tsx`, 'apps/web').path).toBe('apps/web/src/App.tsx')
	})

	test('relativizes a /@fs/ monorepo sibling against the working directory', () => {
		const absolute = `${process.cwd()}/packages/ui/src/Button.tsx`
		expect(moduleUrlToSourcePath(`${APP}/@fs${absolute}`).path).toBe('packages/ui/src/Button.tsx')
	})
})

describe('resolveSourcePath', () => {
	// Regression: a Vite dev module carries an inline map whose only source is the
	// bare file name. Taken literally that yields `EmptyState.tsx` as a separate
	// file from the `src/components/EmptyState.tsx` the module collector already
	// recorded — the same file counted twice, under a name no git diff matches.
	test('resolves a bare source name against the script URL', () => {
		expect(resolveSourcePath('EmptyState.tsx', undefined, `${APP}/src/components/EmptyState.tsx`, {}))
			.toBe('src/components/EmptyState.tsx')
	})

	test('resolves a relative source out of a bundle directory', () => {
		expect(resolveSourcePath('../../src/App.tsx', undefined, `${APP}/assets/index-a1b2c3d4.js`, {}))
			.toBe('src/App.tsx')
	})

	test('applies sourceRoot before resolving', () => {
		expect(resolveSourcePath('App.tsx', 'src', `${APP}/bundle.js`, {})).toBe('src/App.tsx')
	})

	test('still handles bundler pseudo-schemes textually', () => {
		expect(resolveSourcePath('webpack://app/./src/App.tsx', undefined, `${APP}/bundle.js`, {})).toBe('src/App.tsx')
	})

	test('drops vendor sources however they are expressed', () => {
		expect(resolveSourcePath('../node_modules/react/index.js', undefined, `${APP}/src/main.tsx`, {})).toBeNull()
	})
})

describe('normalizeSourceMapPath', () => {
	test('strips bundler scheme prefixes', () => {
		expect(normalizeSourceMapPath('webpack://app/./src/App.tsx')).toBe('src/App.tsx')
		expect(normalizeSourceMapPath('vite:///src/main.ts')).toBe('src/main.ts')
	})

	test('drops vendor sources', () => {
		expect(normalizeSourceMapPath('../node_modules/react/index.js')).toBeNull()
	})
})

describe('aggregation', () => {
	const requests: FootprintRequest[] = [
		{ step: 0, method: 'POST', route: '/graphql', status: 200, resourceType: 'fetch', durationMs: 12,
			operations: [{ type: 'query', name: 'List', rootFields: ['listInvoice'], models: [{ name: 'Invoice', write: false }] }] },
		{ step: 1, method: 'POST', route: '/graphql', status: 200, resourceType: 'fetch', durationMs: 30,
			operations: [{ type: 'mutation', name: 'Pay', rootFields: ['updateInvoice'], models: [{ name: 'Invoice', write: true }] }] },
		{ step: 1, method: 'GET', route: '/api/users/:id', status: 200, resourceType: 'xhr', durationMs: 5 },
	]

	test('groups requests into endpoints with merged methods', () => {
		expect(aggregateEndpoints(requests)).toEqual([
			{ route: '/api/users/:id', methods: ['GET'], count: 1 },
			{ route: '/graphql', methods: ['POST'], count: 2 },
		])
	})

	test('a model read once and written once is reported as written', () => {
		expect(aggregateModels(requests)).toEqual([{ name: 'Invoice', write: true }])
	})
})
