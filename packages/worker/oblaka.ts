import { D1Database, define, R2Bucket, Worker } from 'oblaka-iac'

function envVarsFor(env: string): { READ_TOKEN: string; ADMIN_TOKEN: string } {
	if (env === 'local') {
		// Empty in local — the read gate is bypassed entirely so vite dev
		// (different origin from the worker) can hit /rpc without a cookie
		// dance. Stage/prod must set a real value.
		return { READ_TOKEN: '', ADMIN_TOKEN: 'local-admin' }
	}
	// Stage/prod read tokens from the deploy environment. CI sets these from
	// GitHub secrets; locally `bunx oblaka --env=stage` would need them in
	// .env. Throws loudly if missing so we never ship an open gate.
	const readToken = process.env['OPICE_READ_TOKEN']
	const adminToken = process.env['OPICE_ADMIN_TOKEN']
	if (!readToken || !adminToken) {
		throw new Error(
			`Missing OPICE_READ_TOKEN and/or OPICE_ADMIN_TOKEN for env=${env}. ` +
			`Set them as environment variables before running oblaka.`,
		)
	}
	return { READ_TOKEN: readToken, ADMIN_TOKEN: adminToken }
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
		assets: {
			directory: '../dashboard/dist',
			binding: 'ASSETS',
			html_handling: 'auto-trailing-slash',
			not_found_handling: 'single-page-application',
		},
		bindings: {
			DB: new D1Database({
				name: 'opice',
				migrationsDir: './migrations',
			}),
			SCREENSHOTS: new R2Bucket({
				name: 'opice-screenshots',
			}),
		},
		vars: {
			ENVIRONMENT: env,
			...envVars,
		},
	})
})
