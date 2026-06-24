// opice's deploy surface for VOZKA — folds the old `oblaka.ts` + `propustka.schema.ts` +
// `propustka.access.ts` into ONE `vozka-config` `defineApp`. vozka's engine loads this to deploy opice:
// it materializes the resource graph (provision via oblaka), reconciles `access`/`schema` into propustka,
// and runs the pipeline. `oblaka.ts` stays as the local-dev shim (imports `buildOpiceWorker` from here).
//
// Domain handling: the Worker's Custom Domain route comes from `ctx.domain` (the per-env domain from
// vozka's app registry) — replacing the old `process.env['OPICE_HOSTNAME']` read. `access.destinations`
// keep a process.env fallback only for first-time CF app creation; for opice's EXISTING Access apps the
// reconcile preserves destinations and converges only policies, so the first vozka reconcile is a no-op.

import type { AppAccess, AppSchema, ResourceContext } from 'vozka-config'
import { D1Database, defineApp, R2Bucket, ServiceReference, Worker } from 'vozka-config'

// Stable app id — equals opice's IAM_APP_ID (src/iam.ts) AND the legacy `opice-state` oblaka namespace
// prefix, so opice's first vozka deploy CONTINUES its existing cf-state instead of re-provisioning.
const OPICE_APP_ID = 'opice'

/**
 * opice's full Cloudflare resource graph for one environment — consolidated out of `oblaka.ts`. Both the
 * vozka deploy path (`defineApp` below) and the local-dev `oblaka.ts` shim call this, so the two never drift.
 */
export const buildOpiceWorker = (ctx: ResourceContext): Worker => {
	const { env, domain } = ctx
	const isLocal = env === 'local'

	return new Worker({
		dir: '.',
		name: 'opice-worker',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		// Bind the public hostname (`ctx.domain`) as a Custom Domain (auto DNS + cert + route); Access fronts
		// it (see access below). Declared HERE as IaC so `wrangler deploy` keeps it. No domain → *.workers.dev.
		routes: domain !== undefined && domain !== '' ? [{ pattern: domain, custom_domain: true }] : [],
		observability: { enabled: true },
		// Reap runs abandoned mid-flight (see scheduled() in src/index.ts).
		triggers: { crons: ['*/5 * * * *'] },
		assets: {
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			html_handling: 'auto-trailing-slash',
			not_found_handling: 'single-page-application',
			// Otherwise CF's static-assets binding short-circuits index.html straight to the browser and our
			// read-cookie exchange never runs.
			run_worker_first: true,
		},
		bindings: {
			DB: new D1Database({ name: 'opice', migrationsDir: './migrations', locationHint: 'weur' }),
			SCREENSHOTS: new R2Bucket({ name: 'opice-screenshots', locationHint: 'weur' }),
			// IAM (propustka) — off-local only. Locally src/iam.ts uses the persona-backed FakeIamClient
			// (DEV='true'); there is no Access and no IAM Worker.
			...(isLocal ? {} : { IAM: new ServiceReference('propustka-worker') }),
		},
		vars: {
			ENVIRONMENT: env,
			// Selects the IAM client in src/iam.ts: 'true' (local) → FakeIamClient; '' (off-local) → real IamClient.
			DEV: isLocal ? 'true' : '',
		},
	})
}

/**
 * opice's Cloudflare Access front door, reconciled into propustka. TWO apps: the gated operator host
 * (machines via service tokens + humans), plus a PUBLIC bypass carve-out for the machine API + share
 * links + the install doc. Rule order is the CF precedence order (service-auth before human). WHO the
 * humans are is propustka's central HUMAN_EMAIL_DOMAINS/HUMAN_EMAILS — never declared here.
 *
 * `destinations` are USED only when CREATING a missing CF app; for opice's existing apps the reconcile
 * preserves them. The placeholder fallback keeps this importable on the no-domain local-dev shim path.
 */
const buildAccess = (): AppAccess => {
	const host = process.env['OPICE_HOSTNAME'] ?? 'unset.opice.invalid'
	return {
		apps: [
			{
				key: 'operator',
				name: 'opice-operator',
				destinations: [host],
				sessionDuration: '24h',
				rules: [{ kind: 'service-auth' }, { kind: 'human' }],
			},
			{
				key: 'public',
				name: 'opice-public',
				destinations: [`${host}/api/v1`, `${host}/s`, `${host}/install.md`],
				rules: [{ kind: 'public' }],
			},
		],
	}
}

/**
 * opice's authz vocabulary, reconciled into propustka. One scope dimension (`project`, keyed by slug),
 * the action catalog opice checks/audits, and the canonical app roles. The cross-app super-admin is
 * propustka's built-in `admin = ['*']`, NOT declared here. Mirrors the live propustka schema exactly so
 * the first vozka reconcile is a no-op.
 */
const schema: AppSchema = {
	scopes: [{ type: 'project', label: 'Project' }],
	actions: [
		{ action: 'project.create', description: 'Create a project (audited; gated by project.write)' },
		{ action: 'project.read', description: 'See a project + its metadata/run list' },
		{ action: 'project.write', description: 'Create projects, mint/revoke capabilities' },
		{ action: 'report.read', description: "Read a run's scenarios/steps/screenshots" },
		{ action: 'report.write', description: 'Write run data (the ingest capability grants this)' },
		{ action: 'capability.revoke', description: 'Revoke a capability token (audited)' },
	],
	roles: {
		editor: {
			name: 'Editor',
			description: 'Operate projects and their run reports (read + write).',
			permissions: ['project.*', 'report.*'],
		},
		viewer: {
			name: 'Viewer',
			description: 'Read-only access to projects and their run reports.',
			permissions: ['project.read', 'report.read'],
		},
	},
}

export default defineApp({
	id: OPICE_APP_ID,
	resources: buildOpiceWorker,
	access: buildAccess(),
	schema,
	pipeline: {
		// opice's Worker source lives alongside this config (packages/worker).
		workerDir: '.',
		// Build the dashboard SPA into ../dashboard/dist (the ASSETS directory) before deploy.
		build: 'bun run --filter @opice/dashboard build',
		// opice's old deploy.yml syncs NO app secrets via `wrangler secret put` — its only creds are the
		// platform CF token + propustka reconcile key (both vozka's own config, injected per deploy).
		secrets: [],
	},
})
