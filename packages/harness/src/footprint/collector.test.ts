import { describe, expect, test } from 'bun:test'
import { derivePartialDimensions, splitCustomRoute } from './collector'

describe('splitCustomRoute', () => {
	test('keeps a plain custom route untouched', () => {
		expect(splitCustomRoute('/api/orders/:id')).toEqual({ route: '/api/orders/:id' })
	})

	// The override replaces PATH templating, not the no-query-values rule.
	test('strips query values, keeping only names', () => {
		expect(splitCustomRoute('/search?q=hunter2&token=sk-live-SECRET')).toEqual({
			route: '/search',
			params: ['q', 'token'],
		})
	})

	test('an identity override cannot leak the query', () => {
		const leaky = splitCustomRoute('https://app.test/reset?token=sk-live-SECRET&email=a@b.test')
		expect(leaky.route).toBe('https://app.test/reset')
		expect(JSON.stringify(leaky)).not.toContain('sk-live-SECRET')
		expect(JSON.stringify(leaky)).not.toContain('a@b.test')
	})

	test('drops the fragment — client routers put ids there', () => {
		expect(splitCustomRoute('/app#/invoices/8f3c9b2a')).toEqual({ route: '/app' })
	})

	test('a query with no names yields no params', () => {
		expect(splitCustomRoute('/x?')).toEqual({ route: '/x' })
	})

	test('deduplicates and sorts repeated names', () => {
		expect(splitCustomRoute('/x?b=1&a=2&b=3')).toEqual({ route: '/x', params: ['a', 'b'] })
	})
})

describe('derivePartialDimensions', () => {
	const none = {
		truncatedFiles: 0,
		unmappableFiles: 0,
		coverageFailed: false,
		truncatedRequests: 0,
		persistedQueries: 0,
		mapperFailures: 0,
	}

	test('a clean run vouches for everything', () => {
		expect(derivePartialDimensions(none)).toEqual([])
	})

	// Against a bundle the module collector runs to completion and recognises
	// nothing. "No files" there means "could not tell".
	test('unmappable bundle assets make files partial', () => {
		expect(derivePartialDimensions({ ...none, unmappableFiles: 12 })).toEqual(['files'])
	})

	test('a failed coverage pass makes files partial', () => {
		expect(derivePartialDimensions({ ...none, coverageFailed: true })).toEqual(['files'])
	})

	test('hitting the file cap makes files partial', () => {
		expect(derivePartialDimensions({ ...none, truncatedFiles: 3 })).toEqual(['files'])
	})

	// The request stream feeds both, so losing it costs both.
	test('hitting the request cap makes endpoints and models partial', () => {
		expect(derivePartialDimensions({ ...none, truncatedRequests: 5 }).sort()).toEqual(['endpoints', 'models'])
	})

	// The endpoint was perfectly visible; only the document was missing.
	test('persisted queries cost the models alone', () => {
		expect(derivePartialDimensions({ ...none, persistedQueries: 2 })).toEqual(['models'])
	})

	test('a throwing mapOperation costs the models alone', () => {
		expect(derivePartialDimensions({ ...none, mapperFailures: 1 })).toEqual(['models'])
	})

	test('reports each dimension once however many signals fired', () => {
		const partial = derivePartialDimensions({
			truncatedFiles: 1,
			unmappableFiles: 1,
			coverageFailed: true,
			truncatedRequests: 1,
			persistedQueries: 1,
			mapperFailures: 1,
		})
		expect(partial.sort()).toEqual(['endpoints', 'files', 'models'])
	})
})

// Regression: a production bundle WITH working source maps must still index.
// The module collector cannot name a bundled script by definition, so taking its
// word for it marked every such app's files partial and file-based impact
// selection could never populate.
describe('derivePartialDimensions — bundles with usable source maps', () => {
	const none = {
		truncatedFiles: 0,
		unmappableFiles: 0,
		coverageFailed: false,
		truncatedRequests: 0,
		persistedQueries: 0,
		mapperFailures: 0,
	}

	test('a bundle coverage resolved is not partial', () => {
		// Coverage ran and reported zero unresolvable bundles.
		expect(derivePartialDimensions({ ...none, unmappableFiles: 0 })).toEqual([])
	})

	test('a bundle coverage could NOT resolve is partial', () => {
		expect(derivePartialDimensions({ ...none, unmappableFiles: 7 })).toEqual(['files'])
	})
})

describe('derivePartialDimensions — component walk cap', () => {
	const none = {
		truncatedFiles: 0,
		unmappableFiles: 0,
		coverageFailed: false,
		truncatedRequests: 0,
		persistedQueries: 0,
		mapperFailures: 0,
	}

	// A React tree past the node cap stops being walked, so the names collected
	// are a sample — and component edges are replaced wholesale.
	test('a capped fiber walk makes components partial', () => {
		expect(derivePartialDimensions({ ...none, componentsTruncated: true })).toEqual(['components'])
	})

	test('an uncapped walk vouches for components', () => {
		expect(derivePartialDimensions({ ...none, componentsTruncated: false })).toEqual([])
	})
})

describe('derivePartialDimensions — unreadable coverage and oversized bodies', () => {
	const none = {
		truncatedFiles: 0,
		unmappableFiles: 0,
		coverageFailed: false,
		truncatedRequests: 0,
		persistedQueries: 0,
		mapperFailures: 0,
	}

	// A pass that could not be READ resolved nothing, which is not the same as
	// "every bundle resolved" — taking its empty file list as authoritative would
	// let it wipe the index.
	test('an unreadable coverage pass makes files partial', () => {
		expect(derivePartialDimensions({ ...none, coverageFailed: true, unmappableFiles: 0 })).toEqual(['files'])
	})

	// The endpoint was visible; only the document was too large to scan.
	test('an oversized GraphQL body costs the models alone', () => {
		expect(derivePartialDimensions({ ...none, oversizedBodies: 1 })).toEqual(['models'])
	})
})

describe('derivePartialDimensions — unreadable GraphQL documents', () => {
	const none = {
		truncatedFiles: 0,
		unmappableFiles: 0,
		coverageFailed: false,
		truncatedRequests: 0,
		persistedQueries: 0,
		mapperFailures: 0,
	}

	// A GraphQL GET carrying `?query=…` is recognised as GraphQL, but Playwright
	// reports no post data, so no document ever reaches the parser. Without this
	// the models would read as an authoritative "none".
	test('a request with no readable document costs the models', () => {
		expect(derivePartialDimensions({ ...none, unreadableOperations: 1 })).toEqual(['models'])
	})
})
