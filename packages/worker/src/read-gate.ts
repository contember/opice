/**
 * Cookie-based read gate for the dashboard. Visit `?token=<token>` once to
 * exchange the token for a cookie; subsequent requests just send the
 * cookie. Single-tenant, single-token in v1.
 */

const COOKIE = 'opice_read'

export function hasReadAccess(request: Request, expectedToken: string): boolean {
	if (!expectedToken) return true
	const url = new URL(request.url)
	if (url.searchParams.get('token') === expectedToken) return true
	const cookies = request.headers.get('cookie') ?? ''
	for (const part of cookies.split(';')) {
		const [k, v] = part.trim().split('=')
		if (k === COOKIE && v === expectedToken) return true
	}
	return false
}

export function readAccessRedirect(request: Request, expectedToken: string): Response | null {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (!queryToken || queryToken !== expectedToken) {
		return null
	}
	const next = new URL(url.toString())
	next.searchParams.delete('token')
	return new Response(null, {
		status: 302,
		headers: {
			location: next.toString(),
			'set-cookie': `${COOKIE}=${expectedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
		},
	})
}
