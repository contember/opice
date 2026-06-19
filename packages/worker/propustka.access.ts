import type { AppAccess } from '@propustka/client'
import { opiceAppId } from './propustka.schema'

/**
 * Opice's Cloudflare Access edge rules, declared in code (Access-as-code, EDGE edition).
 *
 * The front-door counterpart of `propustka.schema.ts`: where the schema declares opice's authz
 * vocabulary, this declares WHO reaches opice at the Cloudflare Access edge. The deploy step
 * `scripts/provision-access.ts` reconciles it into Cloudflare via the idempotent
 * `PUT /admin/apps/:app/access` endpoint (`reconcileAccess()`), and Propustka converges it into
 * account-level REUSABLE policies attached to opice's Access application(s).
 *
 * Opice fronts TWO Cloudflare Access applications: the gated operator host, and a public bypass
 * carve-out for the machine API + share links + the install doc. Each entry's `rules` order is the
 * Cloudflare precedence order (service-auth before human).
 *
 * `destinations` are the production hostnames. reconcile only USES them when CREATING a missing CF
 * app; for an existing app it preserves the app's own destinations and changes only its policies —
 * so this never re-routes a live app.
 */
// The opice hostname these Access apps front — REQUIRED, from the OPICE_HOSTNAME deploy var (the same
// var oblaka.ts binds as the Custom Domain). No hardcoded default: a missing value fails loudly rather
// than silently reconciling some other account's hostname. WHO the humans are is NOT declared here —
// propustka owns that centrally (HUMAN_EMAIL_DOMAINS / HUMAN_EMAILS).
const host = process.env['OPICE_HOSTNAME']
if (!host) {
	throw new Error('OPICE_HOSTNAME is not set — provide it for the deploy/reconcile (no hardcoded default).')
}

export const opiceAppAccess: AppAccess = {
	apps: [
		{
			// Operators in a browser (humans) + machines (the read/ingest service tokens).
			key: 'operator',
			name: 'opice-operator',
			destinations: [host],
			sessionDuration: '24h',
			rules: [
				{ kind: 'service-auth' },
				{ kind: 'human' },
			],
		},
		{
			// Public carve-out: the machine API, share links, and the install doc — no Access.
			key: 'public',
			name: 'opice-public',
			destinations: [`${host}/api/v1`, `${host}/s`, `${host}/install.md`],
			rules: [{ kind: 'public' }],
		},
	],
}

// Re-exported so `scripts/provision-access.ts` reads the id + declaration from one place — the same
// `ACCESS_APPS` value the target Propustka must know (see `opiceAppId` in propustka.schema.ts).
export { opiceAppId }
