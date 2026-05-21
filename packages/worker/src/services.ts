import { Db } from './db'
import type { Env } from './env'
import { createAuth, type AuthInstance } from './identity/better-auth'
import { D1Dialect } from './identity/d1-dialect'

/**
 * Pre-wired services + config for every request. Handlers take `Services`
 * (or pick what they need off it) instead of reaching into `env` directly
 * — keeps them decoupled from the CF binding shape and easier to test.
 */
export interface Services {
	readonly db: Db
	readonly auth: AuthInstance
	/** Raw BetterAuth D1, for the few operator ops not exposed by the auth API (role set). */
	readonly authDb: D1Database
	readonly screenshots: R2Bucket
	readonly assets: Fetcher
	readonly config: Config
}

export interface Config {
	/** Bootstrap root-admin credential (Bearer). Mints the first account/token. */
	readonly adminToken: string
	/** Deploy environment name; `local` disables the auth gate (see principal.ts). */
	readonly environment: string
}

export function buildServices(env: Env): Services {
	return {
		db: new Db(env.DB),
		auth: createAuth({
			database: { dialect: new D1Dialect({ database: env.AUTH_DB }), type: 'sqlite' },
			config: {
				secret: env.BETTER_AUTH_SECRET,
				...(env.BETTER_AUTH_URL ? { baseUrl: env.BETTER_AUTH_URL } : {}),
				...(env.BETTER_AUTH_TRUSTED_ORIGINS
					? { trustedOrigins: env.BETTER_AUTH_TRUSTED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) }
					: {}),
			},
		}),
		authDb: env.AUTH_DB,
		screenshots: env.SCREENSHOTS,
		assets: env.ASSETS,
		config: {
			adminToken: env.ADMIN_TOKEN,
			environment: env.ENVIRONMENT,
		},
	}
}
