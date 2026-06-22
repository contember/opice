#!/usr/bin/env bun
/**
 * Reconcile opice's DECLARED Cloudflare Access edge rules into Propustka — Access-as-code, EDGE
 * edition (the front-door counterpart of `provision-schema.ts`).
 *
 * Opice OWNS its Access rules (service-auth / human / public) and declares them in
 * `../propustka.access.ts`. This script PUTs that `AppAccess` to the idempotent admin endpoint
 * `PUT /admin/apps/:app/access` (via `reconcileAccess()` from `@propustka/client`), and Propustka
 * converges Cloudflare's account-level REUSABLE policies to match. The IAM Worker performs the
 * Cloudflare mutations with its own api token (which needs *Access: Apps and Policies — Edit*).
 *
 * Idempotent: reconcile owns only the policies it manages (a `px:<app>:` name prefix) and never
 * touches admin-made ones. Re-running is safe.
 *
 * Run it yourself (the operator targets a deployed/local IAM Worker; nothing here is committed):
 *
 *   PROPUSTKA_URL=https://propustka.example.com    # the IAM Worker's admin origin
 *   # Auth — the admin API is gated by Cloudflare Access. Pick ONE:
 *   #  • local dev: no auth (the IAM Worker's ENVIRONMENT=local + empty ACCESS_APPS resolves a
 *   #    fixed global-admin identity for token-less requests).
 *   #  • remote: an Access SERVICE TOKEN with admin permission.
 *   PROPUSTKA_ACCESS_CLIENT_ID=…       # optional; the service token's Client ID
 *   PROPUSTKA_ACCESS_CLIENT_SECRET=…   # optional; the service token's Client Secret
 *   bun run access:provision [--dry-run]
 *
 * --dry-run parses the declaration and prints the intended reconcile (per CF app + rules) without
 * touching the Worker.
 *
 * The target Propustka must know opice's app id (an `ACCESS_APPS` value) — see `opiceAppId`.
 */

import type { AppAccess } from '@propustka/client'
import { reconcileAccess } from '@propustka/client'
import { opiceAppAccess, opiceAppId } from '../propustka.access'

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

function describe(access: AppAccess): string[] {
	const lines = [`  • ${opiceAppId}`]
	for (const cfApp of access.apps) {
		lines.push(`      ${cfApp.name}  [${cfApp.destinations.join(', ')}]`)
		lines.push(`          rules: ${cfApp.rules.map((r) => r.kind).join(', ')}`)
	}
	return lines
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// The hostname these Access apps front. Required even for --dry-run, since it shapes the
	// declared destinations (the module is now a pure function of it — no import-time env read).
	const access = opiceAppAccess(required('OPICE_HOSTNAME'))

	if (DRY_RUN) {
		console.log('DRY RUN — no changes. Would reconcile these Access rules:\n')
		for (const line of describe(access)) console.log(line)
		console.log('\n1 app — none pushed (--dry-run).')
		return
	}

	const url = required('PROPUSTKA_URL')
	const accessClientId = optional('PROPUSTKA_ACCESS_CLIENT_ID')
	const accessClientSecret = optional('PROPUSTKA_ACCESS_CLIENT_SECRET')
	const authMode = accessClientId !== undefined ? 'Access service token' : 'no auth (local dev bypass)'
	console.log(`Reconciling opice's Access rules against ${url} (${authMode})\n`)

	// reconcileAccess (@propustka/client) does the idempotent PUT + both-or-neither token guard.
	await reconcileAccess({ url, app: opiceAppId, access, accessClientId, accessClientSecret })

	const cfApps = access.apps.length
	const rules = access.apps.reduce((n, a) => n + a.rules.length, 0)
	console.log(`✓ ${opiceAppId.padEnd(16)} ${cfApps} CF app(s), ${rules} rule(s)`)
	console.log('\nDone. Access rules are reconciled (idempotent — non-managed policies untouched).')
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error)
	console.error(`\n✗ ${message}`)
	process.exit(1)
})
