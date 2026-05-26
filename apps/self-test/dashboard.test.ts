import { describe, test } from 'bun:test'
import { browserTest, el, expect, step } from '@opice/harness'

const ENDPOINT = process.env['OPICE_ENDPOINT'] ?? 'https://stage-opice-worker.contember.workers.dev'
const READ_TOKEN = process.env['OPICE_SELF_READ_TOKEN'] ?? ''

if (!READ_TOKEN) {
	throw new Error('OPICE_SELF_READ_TOKEN is required (mirror of stage worker READ_TOKEN secret).')
}

// Open the dashboard with the token query so the worker sets the cookie
// and then 302-redirects to /. After that, every later request carries
// opice_read=<token>.
const ENTRY_URL = `${ENDPOINT}/?token=${READ_TOKEN}`

browserTest({ name: 'Stage dashboard end-to-end', url: ENTRY_URL }, () => {
	describe('home', () => {
		test('renders Projects header', async () => {
			await step('home loads and shows the Projects heading', async () => {
				await expect(el('main h1')).toHaveText('Projects')
			})
		})

		test('lists the self-test project', async () => {
			await step('Opice self-test link is visible', async () => {
				const link = el('a[href="/p/opice-self"]')
				await expect(link).toBeVisible()
				await expect(link).toContainText('Opice self-test')
			})
		})
	})

	describe('project detail navigation', () => {
		test('clicking the project navigates and renders detail', async () => {
			await step('click navigates to /p/opice-self', async () => {
				await el('a[href="/p/opice-self"]').click()
				await expect(el('main h1')).toHaveText('Opice self-test')
			})

			await step('breadcrumb reflects the path', async () => {
				await expect(el('.breadcrumb')).toContainText('Projects')
				await expect(el('.breadcrumb')).toContainText('Opice self-test')
			})
		})

		test('breadcrumb link goes back to projects', async () => {
			await step('click Projects in breadcrumb returns to home', async () => {
				await el('.breadcrumb a[href="/"]').click()
				await expect(el('main h1')).toHaveText('Projects')
			})
		})
	})
})
