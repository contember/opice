import { describe, expect, test } from 'bun:test'
import { browserTest, el, step, waitFor } from '@opice/harness'

const ENDPOINT = process.env['OPICE_ENDPOINT'] ?? 'https://stage-opice-worker.contember.workers.dev'
const READ_TOKEN = process.env['OPICE_SELF_READ_TOKEN'] ?? ''

if (!READ_TOKEN) {
	throw new Error('OPICE_SELF_READ_TOKEN is required (mirror of stage worker READ_TOKEN secret).')
}

// Open the dashboard with the token query so the worker sets the cookie
// and then 302-redirects to /. After that, every later request carries
// opice_read=<token>.
const ENTRY_URL = `${ENDPOINT}/?token=${READ_TOKEN}`

browserTest('Stage dashboard end-to-end', () => {
	describe('home', () => {
		test('renders Projects header', () => {
			step('home loads and shows the Projects heading', () => {
				waitFor(() => el('main h1').text === 'Projects')
				expect(el('main h1').text).toBe('Projects')
			})
		})

		test('lists the self-test project', () => {
			step('Opice self-test link is visible', () => {
				const link = el('a[href="/p/opice-self"]')
				expect(link.exists).toBe(true)
				expect(link.text).toContain('Opice self-test')
			})
		})
	})

	describe('project detail navigation', () => {
		test('clicking the project navigates and renders detail', () => {
			step('click navigates to /p/opice-self', () => {
				el('a[href="/p/opice-self"]').click()
				waitFor(() => el('main h1').text === 'Opice self-test')
				expect(el('main h1').text).toBe('Opice self-test')
			})

			step('breadcrumb reflects the path', () => {
				expect(el('.breadcrumb').text).toContain('Projects')
				expect(el('.breadcrumb').text).toContain('Opice self-test')
			})
		})

		test('breadcrumb link goes back to projects', () => {
			step('click Projects in breadcrumb returns to home', () => {
				el('.breadcrumb a[href="/"]').click()
				waitFor(() => el('main h1').text === 'Projects')
				expect(el('main h1').text).toBe('Projects')
			})
		})
	})
}, { url: ENTRY_URL })
