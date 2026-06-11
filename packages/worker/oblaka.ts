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
			// IAM (propustka): EVERYTHING is propustka. Operator authorization + audit (Access JWT
			// → authenticate) AND every non-operator credential as a capability token
			// (issue/redeem/revoke). The app calls env.IAM.* via @propustka/client. Declared
			// OFF-LOCAL only — locally there is no Access and no IAM Worker, so src/iam.ts swaps in
			// the persona-backed FakeIamClient (DEV='true').
			//
			// ACCESS TOPOLOGY (see packages/worker/CLAUDE.md): the OPERATOR surface is COVERED by
			// Cloudflare Access — `/rpc`, `/screenshots/*`, and the dashboard SPA shell (so the
			// `Cf-Access-Jwt-Assertion` header is injected and propustka resolves the operator).
			// Only TWO things are PUBLIC (Access bypass): `/api/v1/*` ingest and `/s/*` (the
			// read/share surface + `/install.md`). Those carry a propustka capability token
			// (Bearer for ingest, ?token=/cookie for share) redeemed over the binding — the
			// binding does not traverse Access, which is why these can be public.
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
