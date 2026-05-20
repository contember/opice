import { createAuthClient } from 'better-auth/react'

/**
 * BetterAuth browser client. The worker mounts the auth handler at `/auth`
 * (not the default `/api/auth`), so the base path is overridden to match.
 * Endpoints resolve against the current origin — same-origin in prod (the
 * worker serves this SPA), and proxied through Vite in local dev.
 */
export const authClient = createAuthClient({ basePath: '/auth' })

export const { useSession, signIn, signOut } = authClient
