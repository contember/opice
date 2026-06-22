import { Db } from './db'
import type { Env } from './env'
import { createIam, type Iam } from './iam'

/**
 * Pre-wired services + config for every request. Handlers take `Services`
 * (or pick what they need off it) instead of reaching into `env` directly
 * — keeps them decoupled from the CF binding shape and easier to test.
 */
export interface Services {
	readonly db: Db
	/**
	 * The propustka IAM client (real binding off-local; persona-backed fake locally). Drives the
	 * operator + share planes: `authenticate` / `issueCapability` / `redeemCapability` /
	 * `revokeCapability`. The machine (data-plane token) plane never touches it — see principal.ts.
	 */
	readonly iam: Iam
	/**
	 * R2 bucket holding all run artifacts — step screenshots AND scenario videos —
	 * keyed under `<slug>/<runId>/...`. The CF binding is still named `SCREENSHOTS`
	 * (renaming a live bucket would orphan stored objects), but the code-level name
	 * is artifact-neutral since it's no longer screenshots-only.
	 */
	readonly runAssets: R2Bucket
	readonly assets: Fetcher
	readonly config: Config
}

export interface Config {
	/** Deploy environment name; `local` opens the operator gate (see iam.ts / principal.ts). */
	readonly environment: string
	/** 'true' locally → persona-backed FakeIamClient; '' off-local → real IamClient over env.IAM. */
	readonly dev: string
}

export function buildServices(env: Env): Services {
	return {
		db: new Db(env.DB),
		iam: createIam(env),
		runAssets: env.SCREENSHOTS,
		assets: env.ASSETS,
		config: {
			environment: env.ENVIRONMENT,
			dev: env.DEV,
		},
	}
}
