import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: ['project.read', 'report.read'], insert: 'project.write' },
		insert: ['slug', 'name', 'created_at'],
		createdBy: 'created_by',
	},
	runs: {
		scope: { dimension: 'run' },
		actions: {
			read: ['report.read', 'project.read', 'report.write'],
			insert: 'report.write',
			update: 'report.write',
		},
		insert: [
			'branch',
			'commit_sha',
			'status',
			'source',
			'tier',
			'started_at',
			'last_activity_at',
		],
		update: ['status', 'total_scenarios', 'passed_scenarios', 'failed_scenarios', 'last_activity_at', 'reaped_at', 'finished_at'],
	},
	scenarios: {
		scope: { child: 'runs' },
		actions: {
			read: ['report.read', 'report.write'],
			insert: 'report.write',
			update: 'report.write',
		},
		insert: [
			'name',
			'hash',
			'test_file',
			'scenario_file',
			'feature',
			'seeds',
			'roles',
			'tier',
			'status',
			'started_at',
			'finished_at',
			'skipped_at',
			'skip_reason',
		],
		update: ['status', 'duration_ms', 'attempts', 'finished_at'],
	},
	steps: {
		scope: { child: 'runs' },
		actions: {
			read: ['report.read', 'report.write'],
			insert: 'report.write',
		},
		insert: [
			'scenario_id',
			'attempt',
			'sequence',
			'kind',
			'name',
			'status',
			'duration_ms',
			'error',
			'intent',
			'manual',
			'reason',
			'screenshot',
			'screenshot_failed',
			'created_at',
		],
		files: { screenshot: 'screenshots' },
	},
	run_shares: {
		scope: { child: 'runs' },
		actions: { read: 'project.write', insert: 'project.write', update: 'project.write' },
		insert: ['link_id', 'created_at', 'expires_at'],
		update: ['revoked_at'],
		createdBy: 'created_by',
	},
})
