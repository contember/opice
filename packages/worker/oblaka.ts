import { D1Database, define, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'

const KNOWN_ENVS = new Set(['local', 'stage', 'prod'])

export default define(({ env }) => {
	if (!KNOWN_ENVS.has(env)) {
		throw new Error(`Unknown environment ${env}`)
	}
	const isLocal = env === 'local'

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
			// straight to the browser and our read-cookie exchange never runs.
			run_worker_first: true,
		},
		bindings: {
			DB: new D1Database({
				name: 'opice',
				migrationsDir: './migrations',
				locationHint: 'weur',
			}),
			SCREENSHOTS: new R2Bucket({
				name: 'opice-screenshots',
				locationHint: 'weur',
			}),
			// IAM (propustka): operator authorization + audit + run-share capability tokens, over a
			// service binding. Authentication is Cloudflare Access at the edge; the app calls
			// env.IAM.authenticate()/issueCapability()/redeemCapability()/revokeCapability() via
			// @propustka/client. Declared OFF-LOCAL only — locally there is no Access and no IAM
			// Worker, so src/iam.ts swaps in the persona-backed FakeIamClient (DEV='true').
			//
			// NOTE: opice is NOT fully behind Access — anonymous run-share links and the machine
			// data plane (ingest / agent read, presented as Bearer) must reach the Worker without
			// an Access session. Configure Access to FORWARD the JWT for operators but allow
			// unauthenticated requests through (the Worker resolves all three planes itself; see
			// principal.ts). This mirrors poplach keeping its Sentry ingest DSN outside Access.
			...(isLocal ? {} : { IAM: new ServiceReference('propustka-worker') }),
		},
		vars: {
			ENVIRONMENT: env,
			// Selects the IAM client in src/iam.ts: 'true' (local) → FakeIamClient (no Access, no
			// IAM Worker); '' (off-local) → real IamClient over the env.IAM binding.
			DEV: isLocal ? 'true' : '',
		},
	})
})
