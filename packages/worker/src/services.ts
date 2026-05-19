import { Db } from './db'
import type { Env } from './env'

/**
 * Pre-wired services + config for every request. Handlers take `Services`
 * (or pick what they need off it) instead of reaching into `env` directly
 * — keeps them decoupled from the CF binding shape and easier to test.
 */
export interface Services {
	readonly db: Db
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
		screenshots: env.SCREENSHOTS,
		assets: env.ASSETS,
		config: {
			readToken: env.READ_TOKEN,
			adminToken: env.ADMIN_TOKEN,
			environment: env.ENVIRONMENT,
		},
	}
}
