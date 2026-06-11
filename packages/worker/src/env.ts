/**
 * The Worker's CF bindings + secrets. Single source of truth — every other
 * file imports from here, never re-declares the shape.
 */
import type { IamRpc } from '@propustka/client'

export interface Env {
	DB: D1Database
	SCREENSHOTS: R2Bucket
	ASSETS: Fetcher
	/**
	 * propustka IAM Worker — authorization + audit for the operator plane + capability tokens
	 * for run-shares, over a service binding. Authentication is Cloudflare Access at the edge.
	 * Declared OFF-LOCAL only; locally `iam.ts` swaps in the persona-backed FakeIamClient.
	 */
	IAM?: IamRpc
	/** 'true' locally → FakeIamClient (no Access, no IAM Worker); '' off-local → real IamClient. */
	DEV: string
	ENVIRONMENT: string
}
