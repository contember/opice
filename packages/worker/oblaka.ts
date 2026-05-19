import { D1Database, define, R2Bucket, Worker } from 'oblaka-iac'

const envVars = {
	local: {
		READ_TOKEN: 'local-dev',
		ADMIN_TOKEN: 'local-admin',
	},
	stage: {
		READ_TOKEN: 'fill .env',
		ADMIN_TOKEN: 'fill .env',
	},
	prod: {
		READ_TOKEN: 'fill .env',
		ADMIN_TOKEN: 'fill .env',
	},
} as const

export default define(({ env }) => {
	if (!(env in envVars)) {
		throw new Error(`Unknown environment ${env}`)
	}

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
			...envVars[env as keyof typeof envVars],
		},
	})
})
