import { describe, test } from 'bun:test'
import { browserTest, el, expect, step } from '@opice/harness'

const ENDPOINT = process.env['OPICE_ENDPOINT'] ?? 'https://stage-opice-worker.contember.workers.dev'
const READ_TOKEN = process.env['OPICE_SELF_READ_TOKEN'] ?? ''

if (!READ_TOKEN) {
	throw new Error('OPICE_SELF_READ_TOKEN is required (mirror of stage worker READ_TOKEN secret).')
}

// OPICE_SELF_READ_TOKEN is a PROJECT-scoped read capability for `opice-self`.
// The operator dashboard is behind Cloudflare Access — an anonymous, token-bearing
// visitor can only reach the public `/s/*` share surface. Enter on the project
// share view: the worker exchanges `?token=` for the `opice_read` cookie and
// 302s to the clean `/s/p/opice-self`; every later `/s/rpc` call carries the cookie.
const ENTRY_URL = `${ENDPOINT}/s/p/opice-self?token=${READ_TOKEN}`

browserTest({ name: 'Stage dashboard end-to-end', url: ENTRY_URL }, () => {
	describe('project overview share', () => {
		test('renders the project name and run list', async () => {
			await step('the project share view loads with the project name as the heading', async () => {
				await expect(el('main h1')).toHaveText('Opice self-test')
			})

			await step('at least one run is listed', async () => {
				await expect(el('[data-testid="share-run-row"]').first()).toBeVisible()
			})
		})
	})

	describe('run share navigation', () => {
		test('clicking a run navigates to its share run view', async () => {
			await step('click the first run row', async () => {
				await el('[data-testid="share-run-row"] .e-title a').first().click()
			})

			await step('the run detail renders (run heading)', async () => {
				// RunDetail renders the run title as `main h1` → "Run <8-char id>".
				await expect(el('main h1')).toContainText('Run ')
			})
		})
	})
})
