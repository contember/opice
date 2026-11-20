// The previous platform's database (its D1 exported into a SQLite file), read-only. Every row is parsed once here, so
// the import core works on typed values. The schema is that of the previous platform's migrations 0001–0010; the
// scenario video column of 0011 is never read.

import { Database } from 'bun:sqlite'
import { z } from 'zod/v4'

const Text = z.nullable(z.string())
const Int = z.nullable(z.number())

const SourceProject = z.strictObject({
	id: z.number(),
	slug: z.string(),
	name: z.string(),
	created_at: z.number(),
})
export type SourceProject = z.infer<typeof SourceProject>

const SourceRun = z.strictObject({
	id: z.string(),
	branch: Text,
	commit_sha: Text,
	status: z.enum(['running', 'passed', 'failed']),
	source: z.nullable(z.enum(['ci', 'local'])),
	tier: Text,
	total_scenarios: z.number(),
	passed_scenarios: z.number(),
	failed_scenarios: z.number(),
	started_at: z.number(),
	last_activity_at: Int,
	reaped_at: Int,
	finished_at: Int,
})
export type SourceRun = z.infer<typeof SourceRun>

const SourceScenario = z.strictObject({
	id: z.string(),
	name: z.string(),
	hash: Text,
	test_file: Text,
	scenario_file: Text,
	feature: Text,
	seeds: Text,
	roles: Text,
	tier: Text,
	status: z.enum(['running', 'passed', 'failed']),
	duration_ms: Int,
	attempts: z.number(),
	started_at: z.number(),
	finished_at: Int,
	skipped_at: Int,
	skip_reason: Text,
})
export type SourceScenario = z.infer<typeof SourceScenario>

const SourceStep = z.strictObject({
	id: z.number(),
	scenario_id: z.string(),
	attempt: z.number(),
	sequence: z.number(),
	kind: z.enum(['step', 'invariant']),
	name: z.string(),
	status: z.enum(['passed', 'failed', 'fixme', 'fixmepass', 'pending']),
	duration_ms: z.number(),
	error: Text,
	intent: Text,
	manual: Text,
	reason: Text,
	screenshot_r2_key: Text,
	screenshot_failed: z.number(),
	created_at: z.number(),
})
export type SourceStep = z.infer<typeof SourceStep>

const Count = z.strictObject({ n: z.number() })

export interface Source {
	projects(): SourceProject[]
	runs(projectId: number): SourceRun[]
	/** A run's scenarios, ordered by id, after `after` (an id) when given. */
	scenarios(runId: string, after: string | null): SourceScenario[]
	/** A run's steps, ordered by id, after `after` (an id) when given. */
	steps(runId: string, after: number | null): SourceStep[]
	/** Counts over the given projects: rows per table and steps with a screenshot in runs started at or after `since`. */
	counts(projectIds: readonly number[], since: number): SourceCounts
	close(): void
}

export interface SourceCounts {
	readonly runs: number
	readonly scenarios: number
	readonly steps: number
	readonly screenshotsInWindow: number
}

const RUN_COLUMNS = 'id, branch, commit_sha, status, source, tier, total_scenarios, passed_scenarios, failed_scenarios, '
	+ 'started_at, last_activity_at, reaped_at, finished_at'
const SCENARIO_COLUMNS = 'id, name, hash, test_file, scenario_file, feature, seeds, roles, tier, status, duration_ms, '
	+ 'attempts, started_at, finished_at, skipped_at, skip_reason'
const STEP_COLUMNS = 'st.id, st.scenario_id, st.attempt, st.sequence, st.kind, st.name, st.status, st.duration_ms, '
	+ 'st.error, st.intent, st.manual, st.reason, st.screenshot_r2_key, st.screenshot_failed, st.created_at'

export function openSource(path: string): Source {
	const db = new Database(path, { readonly: true, strict: true })
	const count = (sql: string, ...params: number[]) => Count.parse(db.query(sql).get(...params)).n
	const inProjects = (ids: readonly number[]) => ids.length === 0 ? '(NULL)' : `(${ids.map(() => '?').join(', ')})`
	return {
		projects: () => db.query('SELECT id, slug, name, created_at FROM projects ORDER BY id').all().map((row) => SourceProject.parse(row)),
		runs: (projectId) =>
			db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE project_id = ? ORDER BY started_at, id`).all(projectId)
				.map((row) => SourceRun.parse(row)),
		scenarios: (runId, after) =>
			db.query(`SELECT ${SCENARIO_COLUMNS} FROM scenarios WHERE run_id = ? AND id > ? ORDER BY id`).all(runId, after ?? '')
				.map((row) => SourceScenario.parse(row)),
		steps: (runId, after) =>
			db.query(`SELECT ${STEP_COLUMNS} FROM steps st JOIN scenarios sc ON sc.id = st.scenario_id WHERE sc.run_id = ? AND st.id > ? ORDER BY st.id`)
				.all(runId, after ?? -1).map((row) => SourceStep.parse(row)),
		counts: (projectIds, since) => {
			const set = inProjects(projectIds)
			return {
				runs: count(`SELECT count(*) AS n FROM runs WHERE project_id IN ${set}`, ...projectIds),
				scenarios: count(`SELECT count(*) AS n FROM scenarios sc JOIN runs r ON r.id = sc.run_id WHERE r.project_id IN ${set}`, ...projectIds),
				steps: count(
					`SELECT count(*) AS n FROM steps st JOIN scenarios sc ON sc.id = st.scenario_id JOIN runs r ON r.id = sc.run_id WHERE r.project_id IN ${set}`,
					...projectIds,
				),
				screenshotsInWindow: count(
					'SELECT count(*) AS n FROM steps st JOIN scenarios sc ON sc.id = st.scenario_id JOIN runs r ON r.id = sc.run_id '
						+ `WHERE r.project_id IN ${set} AND st.screenshot_r2_key IS NOT NULL AND r.started_at >= ?`,
					...projectIds,
					since,
				),
			}
		},
		close: () => db.close(),
	}
}
