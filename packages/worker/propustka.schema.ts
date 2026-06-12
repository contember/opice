import type { AppSchema } from '@propustka/client'
import { IAM_APP_ID } from './src/iam'

/**
 * Opice's authz vocabulary, declared in code (Access-as-code, authz edition).
 *
 * Opice OWNS its scope dimensions, action catalog, and roles and DECLARES them here. The
 * deploy step `scripts/provision-schema.ts` reconciles this into Propustka via the idempotent
 * `PUT /admin/apps/:app/schema` endpoint (`reconcileSchema()`), so the IAM Worker's DB always
 * mirrors what opice actually checks at runtime — the `can()` / `scopedTo()` calls in
 * `src/principal.ts` and the `audit()` events in `src/router.ts`.
 *
 * Invariants (validated by the admin endpoint via core `isActionAllowed` — keep them true so a
 * push never 400s):
 *   - every role permission is `*`, an exact catalog action, or a `prefix.*` whose prefix covers
 *     at least one catalog action;
 *   - scope `type`s are the dimensions app code passes to `can(action, { type, value })` and
 *     `scopedTo(action, dimension)`.
 *
 * Opice's IAM-facing project key is the project SLUG (see `src/iam.ts`), so the one scope
 * dimension is `project` and its `value`s are slugs.
 */
export const opiceAppSchema: AppSchema = {
	// One flat scope dimension — the project, keyed by slug. `value`s are opaque app-owned ids;
	// Propustka never interprets them.
	scopes: [
		{ type: 'project', label: 'Project' },
	],

	// Every action opice checks (`can`), audits (`audit`), or delegates (capability grants). Role
	// patterns and inline grants reference these strings; a `prefix.*` pattern only validates
	// because actions live under it.
	actions: [
		{ action: 'project.create', description: 'Create a project (audited; gated by project.write)' },
		{ action: 'project.read', description: 'See a project + its metadata/run list' },
		{ action: 'project.write', description: 'Create projects, mint/revoke capabilities' },
		{ action: 'report.read', description: "Read a run's scenarios/steps/screenshots" },
		{ action: 'report.write', description: 'Write run data (the ingest capability grants this)' },
		{ action: 'capability.revoke', description: 'Revoke a capability token (audited)' },
	],

	// origin='app' roles — the canonical bundles opice ships. The cross-app super-admin is
	// Propustka's built-in `admin = ['*']`, NOT declared here. An admin may layer origin='custom'
	// policies on top via the admin UI; reconcile never touches those.
	roles: {
		editor: {
			name: 'Editor',
			description: 'Operate projects and their run reports (read + write).',
			// `project.*` covers create/read/write; `report.*` covers read/write.
			permissions: ['project.*', 'report.*'],
		},
		viewer: {
			name: 'Viewer',
			description: 'Read-only access to projects and their run reports.',
			permissions: ['project.read', 'report.read'],
		},
	},
}

/**
 * The app id this schema is reconciled under — the SAME id opice passes to
 * `new IamClient(env.IAM, IAM_APP_ID)` in `src/iam.ts`, and a value the target Propustka must
 * know (an `ACCESS_APPS` value). Re-exported from `src/iam.ts` so the id has a single source of
 * truth shared by the runtime client and this declaration.
 */
export const opiceAppId = IAM_APP_ID
