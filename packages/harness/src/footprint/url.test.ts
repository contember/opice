import { describe, expect, test } from 'bun:test'
import { isApiResourceType, isIdSegment, toRouteTemplate } from './url.js'

const APP = 'http://localhost:15180'

/** The route of a URL we expect to be templatable — fails loudly if it isn't. */
function route(url: string): string {
	const template = toRouteTemplate(url, APP)
	if (!template) throw new Error(`expected a route template for ${url}`)
	return template.route
}

describe('toRouteTemplate', () => {
	test('keeps only the path for a same-origin URL', () => {
		expect(toRouteTemplate(`${APP}/api/invoices`, APP)).toEqual({ route: '/api/invoices' })
	})

	test('qualifies a third-party URL with its origin', () => {
		expect(toRouteTemplate('https://api.stripe.com/v1/charges', APP)).toEqual({ route: 'https://api.stripe.com/v1/charges' })
	})

	test('collapses uuid, numeric and hash segments', () => {
		expect(route(`${APP}/api/invoices/8f3c1a2b-4d5e-6f70-8192-a3b4c5d6e7f8/lines`)).toBe('/api/invoices/:id/lines')
		expect(route(`${APP}/api/invoices/42`)).toBe('/api/invoices/:id')
		expect(route(`${APP}/assets/9a8b7c6d5e4f3a2b1c0d`)).toBe('/assets/:id')
	})

	test('never collapses the first segment', () => {
		// `/2024/archive` is a route, not an id — collapsing it would merge whole
		// sections of a site into one endpoint row.
		expect(route(`${APP}/2024/archive`)).toBe('/2024/archive')
	})

	test('leaves route-shaped segments alone', () => {
		expect(route(`${APP}/api/v1/admin-dashboard-v2/unsubscribe_all`)).toBe('/api/v1/admin-dashboard-v2/unsubscribe_all')
	})

	test('records query parameter names but never their values', () => {
		const out = toRouteTemplate(`${APP}/api/search?q=secret+term&token=abc123&page=2`, APP)
		expect(out).toEqual({ route: '/api/search', params: ['page', 'q', 'token'] })
		expect(JSON.stringify(out)).not.toContain('secret')
		expect(JSON.stringify(out)).not.toContain('abc123')
	})

	test('returns null for URLs that carry no route', () => {
		expect(toRouteTemplate('data:image/png;base64,iVBOR', APP)).toBeNull()
		expect(toRouteTemplate('not a url', APP)).toBeNull()
	})

	test('handles the origin root', () => {
		expect(toRouteTemplate(APP, APP)).toEqual({ route: '/' })
	})
})

describe('isIdSegment', () => {
	test('accepts identifier shapes past the first segment', () => {
		expect(isIdSegment('01H8XGJWBWBAQ4Z1E3T9K2M5NP', 1)).toBe(true)
		expect(isIdSegment('123', 2)).toBe(true)
	})

	test('rejects words that merely contain digits', () => {
		expect(isIdSegment('v1', 1)).toBe(false)
		expect(isIdSegment('step-2-review', 1)).toBe(false)
	})
})

describe('isApiResourceType', () => {
	test('keeps API traffic and drops static assets', () => {
		expect(isApiResourceType('xhr')).toBe(true)
		expect(isApiResourceType('fetch')).toBe(true)
		expect(isApiResourceType('script')).toBe(false)
		expect(isApiResourceType('image')).toBe(false)
	})
})

describe('redaction', () => {
	// The footprint is uploaded and rendered on a dashboard, so a path segment that
	// isn't a route word is a value — and `isIdSegment` only knows the id shapes.
	test('collapses values isIdSegment cannot recognise', () => {
		expect(route(`${APP}/users/honza@example.com/settings`)).toBe('/users/:id/settings')
		expect(route(`${APP}/reset/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMiJ9.dBjftJeZ4CVP`)).toBe('/reset/:id')
		expect(route(`${APP}/invite/a-very-long-single-use-magic-link-token-value`)).toBe('/invite/:id')
		expect(route(`${APP}/search/Honza%20Sl%C3%A1dek`)).toBe('/search/:id')
	})

	test('no recognisable value survives into the template', () => {
		const template = route(`${APP}/u/honza@example.com/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef`)
		expect(template).not.toContain('@')
		expect(template).not.toContain('eyJ')
	})

	test('collapses a lowercase opaque token', () => {
		// Neither mixed-case nor hex, so `isIdSegment` doesn't recognise it — but a
		// 16+ character unbroken run is a value, not a route name.
		expect(route(`${APP}/reset/abc123def456ghi789`)).toBe('/reset/:id')
		expect(route(`${APP}/s/01h8xgjwbwbaq4z1e3t9k2m5np`)).toBe('/s/:id')
	})

	test('still keeps ordinary route words', () => {
		expect(route(`${APP}/api/v1/admin-dashboard-v2/unsubscribe_all`)).toBe('/api/v1/admin-dashboard-v2/unsubscribe_all')
		expect(route(`${APP}/assets/manifest.json`)).toBe('/assets/manifest.json')
	})
})
