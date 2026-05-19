/**
 * The Worker's CF bindings + secrets. Single source of truth — every other
 * file imports from here, never re-declares the shape.
 */
export interface Env {
	DB: D1Database
	SCREENSHOTS: R2Bucket
	ASSETS: Fetcher
	READ_TOKEN: string
	ADMIN_TOKEN: string
	ENVIRONMENT: string
}
