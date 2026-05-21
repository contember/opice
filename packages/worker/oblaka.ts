import { D1Database, define, R2Bucket, Worker } from 'oblaka-iac'

interface AuthVars {
	READ_TOKEN: string
	ADMIN_TOKEN: string
	BETTER_AUTH_SECRET: string
	BETTER_AUTH_URL: string
	BETTER_AUTH_TRUSTED_ORIGINS: string
}

function envVarsFor(env: string): AuthVars {
	if (env === 'local') {
		// Empty READ_TOKEN in local — the read gate is bypassed entirely so vite
		// dev (different origin from the worker) can hit /rpc without a cookie
		// dance. Stage/prod must set real values.
		return {
			READ_TOKEN: '',
			ADMIN_TOKEN: 'local-admin',
			// Fixed dev secret — fine locally, never used in stage/prod.
			BETTER_AUTH_SECRET: 'local-dev-better-auth-secret-not-for-production',
			BETTER_AUTH_URL: '',
			// The Vite dev SPA proxies to the worker from this origin.
			BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:18182',
		}
	}
	// Stage/prod read secrets from the deploy environment. CI sets these from
	// GitHub secrets. Throws loudly if missing so we never ship an open gate.
	const readToken = process.env['OPICE_READ_TOKEN']
	const adminToken = process.env['OPICE_ADMIN_TOKEN']
	const authSecret = process.env['OPICE_BETTER_AUTH_SECRET']
	if (!readToken || !adminToken || !authSecret) {
		throw new Error(
			`Missing OPICE_READ_TOKEN, OPICE_ADMIN_TOKEN and/or OPICE_BETTER_AUTH_SECRET for env=${env}. ` +
			`Set them as environment variables before running oblaka.`,
		)
	}
	return {
		READ_TOKEN: readToken,
		ADMIN_TOKEN: adminToken,
		BETTER_AUTH_SECRET: authSecret,
		// Same-origin deploy (the worker serves the SPA) → URL inferred, no extra origins.
		BETTER_AUTH_URL: process.env['OPICE_BETTER_AUTH_URL'] ?? '',
		BETTER_AUTH_TRUSTED_ORIGINS: '',
	}
}

const KNOWN_ENVS = new Set(['local', 'stage', 'prod'])

export default define(({ env }) => {
	if (!KNOWN_ENVS.has(env)) {
		throw new Error(`Unknown environment ${env}`)
	}
	const envVars = envVarsFor(env)

	return new Worker({
		dir: '.',
		name: 'opice-worker',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		observability: { enabled: true },
		// Reap runs abandoned mid-flight (see scheduled() in src/index.ts).
		triggers: { crons: ['*/5 * * * *'] },
		assets: {
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			html_handling: 'auto-trailing-slash',
			not_found_handling: 'single-page-application',
			// Otherwise CF's static-assets binding short-circuits index.html
			// straight to the browser and our read-gate never runs.
			run_worker_first: true,
		},
		bindings: {
			DB: new D1Database({
				name: 'opice',
				migrationsDir: './migrations',
				locationHint: 'weur',
			}),
			AUTH_DB: new D1Database({
				name: 'opice-auth',
				migrationsDir: './migrations/auth',
				locationHint: 'weur',
			}),
			SCREENSHOTS: new R2Bucket({
				name: 'opice-screenshots',
				locationHint: 'weur',
			}),
		},
		vars: {
			ENVIRONMENT: env,
			...envVars,
		},
	})
})
