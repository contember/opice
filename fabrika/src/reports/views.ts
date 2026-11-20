// Rows as the dashboard, the share page and the reporter read them: the display status derived, file columns turned
// into the URLs of the procedures that serve them.

import { fromRow } from '@fabrika/app'
import type { RowOf } from '@fabrika/db/tables'
import { z } from 'zod/v4'
import type { tables } from '../db/tables'
import { Run, RunWithProject, Scenario, StepKind, StepStatus, StoredStatus } from '../schemas'
import { decodeList, NO_COUNTS, type RunCounts, runDisplayStatus, scenarioDisplayStatus } from './logic'

type RunRowShape = {
	readonly id: string
	readonly projectId: string
	readonly branch: string | null
	readonly commitSha: string | null
	readonly status: 'running' | 'passed' | 'failed'
	readonly source: 'ci' | 'local' | null
	readonly tier: string | null
	readonly startedAt: number
	readonly lastActivityAt: number | null
	readonly reapedAt: number | null
	readonly finishedAt: number | null
}

const runFields = (row: RunRowShape, counts: RunCounts | undefined, now: number) => {
	const tally = counts ?? NO_COUNTS
	return {
		id: row.id,
		projectId: row.projectId,
		branch: row.branch,
		commitSha: row.commitSha,
		status: runDisplayStatus(row, tally, now),
		source: row.source,
		tier: row.tier,
		totalScenarios: tally.total,
		passedScenarios: tally.passed,
		failedScenarios: tally.failed,
		warningScenarios: tally.warning,
		incompleteScenarios: tally.incomplete,
		skippedScenarios: tally.skipped,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
	}
}

export const toRun = (row: RunRowShape, counts: RunCounts | undefined, now: number): z.output<typeof Run> => runFields(row, counts, now)

export const toRunWithProject = (
	row: RunRowShape & { readonly projectSlug: string; readonly projectName: string },
	counts: RunCounts | undefined,
	now: number,
): z.output<typeof RunWithProject> => ({ ...runFields(row, counts, now), projectSlug: row.projectSlug, projectName: row.projectName })

const StoredRun = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	branch: z.nullable(z.string()),
	commitSha: z.nullable(z.string()),
	status: StoredStatus,
	source: z.nullable(z.enum(['ci', 'local'])),
	tier: z.nullable(z.string()),
	startedAt: z.int(),
	lastActivityAt: z.nullable(z.int()),
	reapedAt: z.nullable(z.int()),
	finishedAt: z.nullable(z.int()),
})

/** A run row of the data layer, its stored status and source checked against what the migration admits. */
export const storedRun = (row: RowOf<typeof tables, 'runs'>): RunRowShape => fromRow(StoredRun, row)

export const toScenario = (
	row: RowOf<typeof tables, 'scenarios'>,
	flags: { readonly hasPending: boolean; readonly hasWarning: boolean } | undefined,
): z.output<typeof Scenario> => {
	const status = StoredStatus.parse(row.status)
	return {
		id: row.id,
		runId: row.run_id,
		name: row.name,
		hash: row.hash,
		testFile: row.test_file,
		scenarioFile: row.scenario_file,
		feature: row.feature,
		seeds: decodeList(row.seeds),
		roles: decodeList(row.roles),
		tier: row.tier,
		skipReason: row.skip_reason,
		status: scenarioDisplayStatus({ status, skippedAt: row.skipped_at }, flags ?? { hasPending: false, hasWarning: false }),
		durationMs: row.duration_ms,
		attempts: row.attempts,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		// Videos wait for the framework to verify video/webm; until then no scenario has one.
		videoUrl: null,
	}
}

export const toStep = (row: RowOf<typeof tables, 'steps'>, screenshotUrl: string | null) => ({
	id: row.id,
	scenarioId: row.scenario_id,
	attempt: row.attempt,
	sequence: row.sequence,
	kind: StepKind.parse(row.kind),
	name: row.name,
	status: StepStatus.parse(row.status),
	durationMs: row.duration_ms,
	error: row.error,
	intent: row.intent,
	manual: row.manual,
	reason: row.reason,
	screenshotUrl,
	screenshotFailed: row.screenshot_failed,
	createdAt: row.created_at,
})
