import { type Auth, betterAuth, type BetterAuthOptions } from 'better-auth'
import { admin } from 'better-auth/plugins'

export interface AuthConfig {
	/** Signing secret for session cookies/tokens. Must be ≥ 32 chars. */
	secret: string
	/**
	 * Public base URL of the worker (e.g. `https://opice.example.com`). Optional
	 * — BetterAuth infers it from the request when omitted, which is correct for
	 * the same-origin prod deploy (the worker serves the SPA).
	 */
	baseUrl?: string
	/**
	 * Extra origins allowed to drive auth (CSRF allowlist). In local dev the
	 * Vite SPA runs on a different port and proxies to the worker, so its origin
	 * is added here; prod is same-origin and needs none.
	 */
	trustedOrigins?: string[]
}

export interface AuthFactoryDeps {
	config: AuthConfig
	database: BetterAuthOptions['database']
}

/**
 * Opice's BetterAuth instance: email + password only. No email verification,
 * no password-reset mail, no social providers — opice ships no mailer.
 *
 * The `admin` plugin adds a `role` column to the user table. Opice reads it in
 * `principal.ts` to map a session to capabilities: `admin` → full access,
 * `member` → read+write (no user/token management). New accounts default to
 * `admin` (the historical "every account is a full operator"), explicitly
 * downgradable via `admin.createUser`.
 *
 * Self-service signup is intentionally NOT disabled at the config level (the
 * server-side `auth.api.signUpEmail` we use for operator-created accounts must
 * keep working); instead the public `/auth/sign-up/*` route is blocked in
 * `routes/auth.ts`. Accounts are created via the `admin.createUser` RPC.
 */
export function buildAuthOptions(deps: AuthFactoryDeps): BetterAuthOptions {
	const { config, database } = deps
	return {
		...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
		...(config.trustedOrigins ? { trustedOrigins: config.trustedOrigins } : {}),
		secret: config.secret,
		basePath: '/auth',
		database,
		plugins: [admin({ defaultRole: 'admin', adminRoles: ['admin'] })],
		session: {
			// Stash the session in a short-lived signed cookie so the per-request
			// `getSession` in the resolver doesn't hit AUTH_DB on every call.
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		emailAndPassword: {
			enabled: true,
			minPasswordLength: 10,
		},
	}
}

export function createAuth(deps: AuthFactoryDeps): Auth {
	return betterAuth(buildAuthOptions(deps))
}

export type AuthInstance = ReturnType<typeof createAuth>
