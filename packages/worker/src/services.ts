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
	readonly screenshots: R2Bucket
	readonly assets: Fetcher
	readonly config: Config
}

export interface Config {
	readonly readToken: string
	readonly adminToken: string
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
		screenshots: env.SCREENSHOTS,
		assets: env.ASSETS,
		config: {
			readToken: env.READ_TOKEN,
			adminToken: env.ADMIN_TOKEN,
			environment: env.ENVIRONMENT,
		},
	}
}
