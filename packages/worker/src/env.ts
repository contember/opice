/**
 * The Worker's CF bindings + secrets. Single source of truth — every other
 * file imports from here, never re-declares the shape.
 */
export interface Env {
	DB: D1Database
	/** Separate D1 owned by BetterAuth (user/session/account/verification). */
	AUTH_DB: D1Database
	SCREENSHOTS: R2Bucket
	ASSETS: Fetcher
	READ_TOKEN: string
	ADMIN_TOKEN: string
	/** BetterAuth session signing secret (≥ 32 chars). */
	BETTER_AUTH_SECRET: string
	/** Public base URL of the worker; optional, inferred from the request when empty. */
	BETTER_AUTH_URL: string
	/** Comma-separated extra CSRF-trusted origins (e.g. the local Vite dev origin). */
	BETTER_AUTH_TRUSTED_ORIGINS: string
	ENVIRONMENT: string
}
