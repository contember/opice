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
