import { D1Database, define, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'

const KNOWN_ENVS = new Set(['local', 'stage', 'prod'])

export default define(({ env }) => {
	if (!KNOWN_ENVS.has(env)) {
		throw new Error(`Unknown environment ${env}`)
	}
	const isLocal = env === 'local'

	// Public hostname, bound below as a Custom Domain. Driven per-env by the OPICE_HOSTNAME deploy var
	// (a GitHub Environment variable the workflow passes) so each target gets its OWN domain instead of
	// one hardcoded account. Unset (stage/local) -> *.workers.dev.
	const hostname = isLocal ? undefined : process.env['OPICE_HOSTNAME']

	return new Worker({
		dir: '.',
		name: 'opice-worker',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		// Bind the public hostname (OPICE_HOSTNAME) as a Custom Domain (auto-creates DNS + cert + route);
		// Cloudflare Access fronts it (see propustka.access.ts). Declared HERE as IaC because oblaka
		// regenerates wrangler.jsonc on every deploy — a domain attached only in the dashboard gets
		// wiped by the next `wrangler deploy`. Unset -> *.workers.dev.
		routes: hostname ? [{ pattern: hostname, custom_domain: true }] : [],
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
			// IAM (propustka): EVERYTHING is propustka. Operators + machines authenticate via Access
			// (authenticate -> AuthContext); only anonymous run-shares are capability tokens. The app
			// calls env.IAM.* via @propustka/client. Declared OFF-LOCAL only — locally there is no
			// Access and no IAM Worker, so src/iam.ts swaps in the persona-backed FakeIamClient
			// (DEV='true'), which also resolves a locally minted service token by its CF-Access-Client-Id.
			//
			// ACCESS TOPOLOGY (see packages/worker/CLAUDE.md) — three planes by audience:
			//   BEHIND Access: `/rpc` + `/screenshots/*` + dashboard SPA (operators, user JWT) AND
			//     `/api/v1/*` (machines — a SERVICE-TOKEN principal; the reporter/agent send the
			//     `CF-Access-Client-*` pair, accepted by an "Any Access Service Token" Service Auth
			//     policy). NOTE: that Access policy is Cloudflare-dashboard config, NOT oblaka.ts.
			//   PUBLIC (Access bypass): `/s/*` (anonymous share/read + `?token=`/cookie) + `/install.md`.
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
