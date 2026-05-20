import type { Services } from '../services'

/**
 * BetterAuth's native handler, mounted at `/auth/*` (sign-in, sign-out,
 * get-session, …).
 *
 * Self-service signup is closed: opice accounts are created by an operator
 * (`POST /api/v1/admin/users` / `opice users create`). We block the public
 * `/auth/sign-up/*` route here so the only way in is an operator-issued
 * account. Everything else passes straight through to BetterAuth.
 */
export async function handleAuth(request: Request, services: Services, path: string): Promise<Response> {
	if (path.startsWith('sign-up')) {
		return new Response(JSON.stringify({ error: { type: 'forbidden', message: 'self-service signup is disabled' } }), {
			status: 403,
			headers: { 'content-type': 'application/json' },
		})
	}
	return services.auth.handler(request)
}
