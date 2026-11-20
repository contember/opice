// Opice's whole access surface. The proxy enforces it from the endpoint table the deployer compiles out of this file.

import { app } from './src/app-kit'
import { migration } from './src/migration/endpoints'
import { projects, reads, reapStaleRuns, reports, runs, session, shared, shares } from './src/reports/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { session, projects, runs, shares }),
	machine: c.rpc('/machine', { reports, reads, migration }),
	shared,
	site: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
	files: {
		screenshots: c.files({ types: ['image/png'], maxBytes: 2097152 }),
	},
	jobs: { reapStaleRuns },
}))
