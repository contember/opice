import { describe, expect, test } from 'bun:test'
import { splitCustomRoute } from './collector'

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
