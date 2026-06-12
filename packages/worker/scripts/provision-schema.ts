#!/usr/bin/env bun
/**
 * Reconcile opice's DECLARED authz vocabulary into Propustka — Access-as-code, authz edition.
 *
 * Opice OWNS its scope dimensions, action catalog, and roles and declares them in
 * `../propustka.schema.ts`. This script PUTs that `AppSchema` to the idempotent admin endpoint
 * `PUT /admin/apps/:app/schema` (via `reconcileSchema()` from `@propustka/client`), so the IAM
 * Worker's DB always mirrors what opice actually checks at runtime — the `can()` / `scopedTo()`
 * calls in `src/principal.ts` and the `audit()` events in `src/router.ts`.
 *
 * Idempotent: the endpoint upserts scopes/actions/origin='app' roles and deletes app-origin rows
 * absent from the body; origin='custom' policies are never touched. Re-running is safe.
 *
 * Run it yourself (the operator targets a deployed/local IAM Worker; nothing here is committed):
 *
 *   PROPUSTKA_URL=https://propustka.example.com    # the IAM Worker's admin origin
 *   # Auth — the admin API is gated by Cloudflare Access. Pick ONE:
 *   #  • local dev: no auth. The IAM Worker's ENVIRONMENT=local + empty ACCESS_APPS resolves a
 *   #    fixed global-admin identity for token-less requests, so a local run needs nothing.
 *   #  • remote: an Access SERVICE TOKEN with admin permission. Access validates the pair at the
 *   #    edge and forwards the JWT the admin gate reads.
 *   PROPUSTKA_ACCESS_CLIENT_ID=…       # optional; the service token's Client ID
 *   PROPUSTKA_ACCESS_CLIENT_SECRET=…   # optional; the service token's Client Secret
 *   bun run schema:provision [--dry-run]
 *
 * --dry-run parses the declaration and prints the intended reconcile (scopes / actions / roles)
 * without touching the Worker.
 *
 * The target Propustka must know opice's app id (an `ACCESS_APPS` value) — see `opiceAppId`.
 */

import { reconcileSchema } from '@propustka/client'
import { opiceAppId, opiceAppSchema } from '../propustka.schema'

// ── env ───────────────────────────────────────────────────────────────────────

function required(name: string): string {
	const value = process.env[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing required env var ${name}`)
	}
	return value
}

function optional(name: string): string | undefined {
	const value = process.env[name]
	return value === undefined || value === '' ? undefined : value
}

const DRY_RUN = process.argv.includes('--dry-run')

// ── reporting ─────────────────────────────────────────────────────────────────

function describe(): string[] {
	const lines = [`  • ${opiceAppId}`]
	lines.push(`      scopes:  ${opiceAppSchema.scopes.map((s) => s.type).join(', ') || '(none)'}`)
	lines.push(`      actions: ${opiceAppSchema.actions.map((a) => a.action).join(', ') || '(none)'}`)
	const roles = Object.entries(opiceAppSchema.roles).map(([key, def]) => `${key} [${def.permissions.join(' ')}]`)
	lines.push(`      roles:   ${roles.join('; ') || '(none)'}`)
	return lines
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (DRY_RUN) {
		console.log('DRY RUN — no changes. Would reconcile this app schema:\n')
		for (const line of describe()) console.log(line)
		console.log('\n1 app schema — none pushed (--dry-run).')
		return
	}

	const url = required('PROPUSTKA_URL')
	const accessClientId = optional('PROPUSTKA_ACCESS_CLIENT_ID')
	const accessClientSecret = optional('PROPUSTKA_ACCESS_CLIENT_SECRET')
	const authMode = accessClientId !== undefined ? 'Access service token' : 'no auth (local dev bypass)'
	console.log(`Reconciling opice's app schema against ${url} (${authMode})\n`)

	// reconcileSchema (@propustka/client) does the idempotent PUT + both-or-neither token guard.
	await reconcileSchema({ url, app: opiceAppId, schema: opiceAppSchema, accessClientId, accessClientSecret })

	const scopes = opiceAppSchema.scopes.length
	const actions = opiceAppSchema.actions.length
	const roles = Object.keys(opiceAppSchema.roles).length
	console.log(`✓ ${opiceAppId.padEnd(16)} ${scopes} scope(s), ${actions} action(s), ${roles} role(s)`)
	console.log('\nDone. Schema is reconciled (idempotent — origin=custom policies untouched).')
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`\n✗ ${message}`)
	process.exit(1)
})
