import { createAuthClient } from 'better-auth/react'

/**
 * BetterAuth browser client. The worker mounts the auth handler at `/auth`
 * (not the default `/api/auth`), so the base path is overridden to match.
 * Endpoints resolve against the current origin — same-origin in prod (the
 * worker serves this SPA), and proxied through Vite in local dev.
 */
export const authClient = createAuthClient({ basePath: '/auth' })

export const { useSession, signIn, signOut, changePassword } = authClient

/**
 * The session's user carries a `role` column from BetterAuth's admin plugin,
 * but the client type (built without the admin plugin) doesn't surface it.
 * `member` is read+write; everything else (incl. the default `admin`) can
 * manage users — mirrors `capabilitiesForRole` in the worker's principal.ts.
 */
export function isOperator(user: unknown): boolean {
	if (!user || typeof user !== 'object') return false
	return (user as { role?: string | null }).role !== 'member'
}
