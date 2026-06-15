/**
 * IAM client factory (propustka).
 *
 * Opice delegates AUTHENTICATION of human operators to Cloudflare Access at the edge and
 * AUTHORIZATION + AUDIT to the propustka IAM Worker, reached over the `IAM` service binding.
 * Operator code never validates a JWT, never manages sessions — it calls `iam.authenticate()`
 * once per request and then `auth.can()` / `auth.scopedTo()` / `auth.audit()` (all local except
 * `audit`). Anonymous run-share links are propustka *capability tokens*
 * (`iam.issueCapability()` / `redeemCapability()` / `revokeCapability()`).
 *
 * THREE planes, all propustka:
 *   - OPERATOR — a human behind Access (`authenticate()` → AuthContext, `/rpc` + dashboard).
 *   - MACHINE — CI ingest + the agent read DSN are propustka SERVICE TOKENS
 *     (`iam.issueServiceToken()` / `revokeServiceToken()` / `rotateServiceToken()`): a Cloudflare
 *     Access service token backed by a service principal carrying report.write / report.read.
 *     The Access edge validates the `CF-Access-Client-*` pair on `/api/v1` (an "Any Access Service
 *     Token" policy) and `authenticate()` resolves the service principal — so machine callers are
 *     real principals checked by `can()`, NOT anonymous capabilities or app-local hashed tokens.
 *   - SHARE — anonymous per-run browser links are capability tokens on `/s/*`.
 *
 * Two modes, selected by the `DEV` var (set in oblaka.ts):
 *   - local (`DEV='true'`)  → `FakeIamClient` in persona mode: the active operator is the
 *     `propustka_dev_principal` cookie's persona (set via `/__dev/login?as=<email>`), defaulting
 *     to the admin persona so a plain `bun run dev` can click everything (the old "local is open"
 *     gate). No Access, no IAM Worker. Capability + service-token issue/redeem/revoke run fully
 *     in-memory; a locally minted service token authenticates by its `CF-Access-Client-Id`.
 *   - off-local (`DEV=''`)  → real `IamClient` over `env.IAM`.
 *
 * The caller `app` id ('opice') is baked in here so it can never be forgotten or mistyped.
 *
 * PROJECT IDENTITY: opice's IAM-facing project key is the project SLUG (stable, human-meaningful)
 * — `can('project.read', { type: 'project', value: slug })` and `scopedTo('project.read', 'project')`
 * deal in slugs, which is what IAM grants reference. The integer `projects.id` stays app-internal.
 */
import { FakeIamClient, type FakePersona, IamClient, type IamRpc } from '@propustka/client'

/** The propustka app id for opice. */
export const IAM_APP_ID = 'opice'

/** Cookie the dev persona-switch sets; read by the FakeIamClient persona resolver. */
export const DEV_PERSONA_COOKIE = 'propustka_dev_principal'

/** Default dev persona (no cookie) — the seeded admin, so plain `bun run dev` is full access. */
export const DEV_DEFAULT_EMAIL = 'admin@opice.test'

/** The bindings + vars the IAM factory needs (a subset of the Worker `Env`). */
export interface IamEnv {
	IAM?: IamRpc
	DEV: string
}

/** The shared surface of the real and fake clients (both satisfy it structurally). */
export type Iam = IamClient | FakeIamClient

/**
 * DEV-only operator personas — the local stand-in for IAM grants, keyed by email. Each maps to
 * the opice action taxonomy so the operator gating (read / write / token.manage) is exercisable
 * locally without Access or a running IAM Worker:
 *   - admin  → `*`                                   (read + write + token.manage, every project)
 *   - member → `project.read` + `project.write`      (operate, but no token inventory)
 *   - viewer → `project.read`                          (read-only dashboard)
 * All are app-wide (global) — opice has no per-project member table; a real deploy expresses
 * project-scoped grants in IAM, which the off-local `IamClient` resolves for real.
 */
const DEV_PERSONAS: Record<string, FakePersona> = {
	[DEV_DEFAULT_EMAIL]: {
		id: 'dev-admin',
		label: DEV_DEFAULT_EMAIL,
		type: 'user',
		permissions: [{ action: '*', scope: null, source: 'grant' }],
	},
	'member@opice.test': {
		id: 'dev-member',
		label: 'member@opice.test',
		type: 'user',
		permissions: [
			{ action: 'project.read', scope: null, source: 'grant' },
			{ action: 'project.write', scope: null, source: 'grant' },
		],
	},
	'viewer@opice.test': {
		id: 'dev-viewer',
		label: 'viewer@opice.test',
		type: 'user',
		permissions: [{ action: 'project.read', scope: null, source: 'grant' }],
	},
}

// Memoized per Worker isolate. The FakeIamClient holds an in-memory capability registry (issued /
// revoked ids) that must survive across requests so a locally minted share link still
// redeems/revokes on the NEXT request; `buildServices` runs per request, so without this the
// registry would reset every call. The real IamClient is stateless, but caching it is harmless.
let cached: Iam | null = null

/**
 * Build the IAM client. Local dev gets the persona-backed fake; off-local gets the real binding
 * (which must be present — it's declared in oblaka.ts off-local).
 */
export function createIam(env: IamEnv): Iam {
	if (cached) return cached
	if (env.DEV) {
		cached = new FakeIamClient({
			personas: DEV_PERSONAS,
			personaCookie: DEV_PERSONA_COOKIE,
			defaultPersona: DEV_DEFAULT_EMAIL,
		})
		return cached
	}
	if (!env.IAM) {
		throw new Error(
			'IAM service binding is missing off-local — check the propustka ServiceReference in oblaka.ts and that operator routes are behind Cloudflare Access.',
		)
	}
	cached = new IamClient(env.IAM, IAM_APP_ID)
	return cached
}
