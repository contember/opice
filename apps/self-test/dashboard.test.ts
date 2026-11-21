import { browserTest, byLabel, byRole, byText, currentUrl, expect, invariant, open, step } from '@opice/harness'

// The platform's own smoke test: what an anonymous visitor gets from the deployed platform. Run through
// `opice test` with the platform test project's DSN, it also proves the reporting path end to end.
const ENDPOINT = process.env['OPICE_SELF_TEST_URL'] ?? 'https://opice.contember.online'

browserTest({ name: 'Platform serves an anonymous visitor', url: `${ENDPOINT}/`, tier: 'critical' }, async () => {
	await step('the dashboard sends an anonymous visitor to sign in', {
		intent: 'The operator dashboard is never served without a session: the proxy bounces to the identity provider.',
	}, async () => {
		await expect(byRole('heading', 'Sign in to Opice')).toBeVisible()
		await expect(byLabel('Email')).toBeVisible()
		await expect(byLabel('Password')).toBeVisible()
		expect(new URL(currentUrl()).origin).not.toBe(new URL(ENDPOINT).origin)
	})

	await step('the share view loads without signing in', {
		intent: 'A share link opens for anyone: the share SPA is public, and without a key it says so instead of bouncing to sign-in.',
	}, async () => {
		await open(`${ENDPOINT}/s/`)
		await expect(byText('This link carries no key')).toBeVisible()
		expect(new URL(currentUrl()).origin).toBe(new URL(ENDPOINT).origin)
	})

	await invariant('the health check answers', async () => {
		// Not followed: a redirect to sign-in would end on a 200 page and pass by mistake.
		const response = await fetch(`${ENDPOINT}/healthz`, { redirect: 'manual' })
		expect(response.status).toBe(200)
	})
})
