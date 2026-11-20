// The raw reads behind run and scenario lists: tallies over scenarios and the flags of each scenario's final attempt.
// Each statement scopes every table it reads through `scope`, which the caller binds to its endpoint's capability.

import type { SqlHandle, SqlScope } from '@fabrika/app/contract'
import type { app } from '../app-kit'
import {
	FinishCountsRow,
	NextSequenceRow,
	RunCountsRow,
	RunRow,
	RunWithProjectRow,
	ScenarioFlagsRow,
} from '../schemas'
import { type RunCounts } from './logic'

type Sql = SqlHandle<typeof app, 'read'>

/** The scope fragment of the endpoint's capability on one table, under the alias the statement gives it. */
export type Scoper = (table: 'runs' | 'scenarios' | 'steps', alias: string) => SqlScope

/** Tallies of the runs' scenarios, keyed by run id; a run with no scenario is absent. */
export const runCounts = async (sql: Sql, scope: Scoper, runIds: readonly string[]): Promise<Map<string, RunCounts>> => {
	if (runIds.length === 0) {
		return new Map()
	}
	const ids = JSON.stringify(runIds)
	const rows = await sql(RunCountsRow)`
		with latest as (
			select st.scenario_id as scenario_id, max(st.attempt) as attempt
			from steps st
			where st.run_id in (select value from json_each(${ids})) and ${scope('steps', 'st')}
			group by st.scenario_id
		), flags as (
			select fs.scenario_id as scenario_id,
				max(case when fs.status = 'pending' then 1 else 0 end) as has_pending,
				max(case when fs.status in ('fixme', 'fixmepass') then 1 else 0 end) as has_warning
			from steps fs
			join latest l on l.scenario_id = fs.scenario_id and l.attempt = fs.attempt
			where ${scope('steps', 'fs')}
			group by fs.scenario_id
		)
		select s.run_id as run_id,
			sum(case when s.skipped_at is null then 1 else 0 end) as total,
			sum(case when s.status = 'passed' then 1 else 0 end) as passed,
			sum(case when s.status = 'failed' then 1 else 0 end) as failed,
			sum(case when s.skipped_at is not null then 1 else 0 end) as skipped,
			sum(case when s.status = 'passed' and coalesce(f.has_warning, 0) = 1 and coalesce(f.has_pending, 0) = 0 then 1 else 0 end) as warning,
			sum(case when s.status = 'passed' and coalesce(f.has_pending, 0) = 1 then 1 else 0 end) as incomplete
		from scenarios s
		left join flags f on f.scenario_id = s.id
		where s.run_id in (select value from json_each(${ids})) and ${scope('scenarios', 's')}
		group by s.run_id`
	return new Map(rows.map((row) => [row.runId, row]))
}

/** Whether each scenario of a run carries a pending or a fixme step in its final attempt, keyed by scenario id. */
export const scenarioFlags = async (sql: Sql, scope: Scoper, runId: string): Promise<Map<string, { hasPending: boolean; hasWarning: boolean }>> => {
	const rows = await sql(ScenarioFlagsRow)`
		with latest as (
			select st.scenario_id as scenario_id, max(st.attempt) as attempt
			from steps st
			where st.run_id = ${runId} and ${scope('steps', 'st')}
			group by st.scenario_id
		)
		select fs.scenario_id as scenario_id,
			max(case when fs.status = 'pending' then 1 else 0 end) as has_pending,
			max(case when fs.status in ('fixme', 'fixmepass') then 1 else 0 end) as has_warning
		from steps fs
		join latest l on l.scenario_id = fs.scenario_id and l.attempt = fs.attempt
		where ${scope('steps', 'fs')}
		group by fs.scenario_id`
	return new Map(rows.map((row) => [row.scenarioId, { hasPending: row.hasPending === 1, hasWarning: row.hasWarning === 1 }]))
}

/** The next sequence of a scenario's attempt, for a reporter that sends none (it arrived in order). */
export const nextSequence = async (sql: Sql, scope: Scoper, scenarioId: string, attempt: number): Promise<number> => {
	const [row] = await sql(NextSequenceRow)`
		select coalesce(max(st.sequence), -1) + 1 as next from steps st
		where st.scenario_id = ${scenarioId} and st.attempt = ${attempt} and ${scope('steps', 'st')}`
	return row?.next ?? 0
}

/** All scenarios of a run, the executed ones, and how many passed or failed: what finishing a run stores. */
export const finishCounts = async (sql: Sql, scope: Scoper, runId: string) => {
	const [row] = await sql(FinishCountsRow)`
		select count(*) as grand,
			coalesce(sum(case when s.skipped_at is null then 1 else 0 end), 0) as executed,
			coalesce(sum(case when s.status = 'passed' and s.skipped_at is null then 1 else 0 end), 0) as passed,
			coalesce(sum(case when s.status = 'failed' then 1 else 0 end), 0) as failed
		from scenarios s
		where s.run_id = ${runId} and ${scope('scenarios', 's')}`
	return row ?? { grand: 0, executed: 0, passed: 0, failed: 0 }
}

/** A page of a project's runs, newest first, with one more row than `limit` to tell whether another page exists. */
export const projectRuns = (sql: Sql, scope: Scoper, limit: number, offset: number) =>
	sql(RunRow)`
		select r.id, r.project_id, r.branch, r.commit_sha, r.status, r.source, r.tier, r.started_at, r.last_activity_at, r.reaped_at, r.finished_at
		from runs r
		where ${scope('runs', 'r')}
		order by r.started_at desc
		limit ${limit + 1} offset ${offset}`

/** A page of every run the caller reads, newest first, each with its project's slug and name. */
export const allRuns = (sql: Sql, scope: Scoper, projectScope: SqlScope, limit: number, offset: number) =>
	sql(RunWithProjectRow)`
		select r.id, r.project_id, p.slug as project_slug, p.name as project_name, r.branch, r.commit_sha, r.status,
			r.source, r.tier, r.started_at, r.last_activity_at, r.reaped_at, r.finished_at
		from runs r
		join projects p on p.id = r.project_id and ${projectScope}
		where ${scope('runs', 'r')}
		order by r.started_at desc
		limit ${limit + 1} offset ${offset}`

/** Each project's headline run: its newest on main or master, else its newest on any branch. */
export const headlineRuns = (sql: Sql, scope: Scoper) =>
	sql(RunRow)`
		with ranked as (
			select r.id as id, row_number() over (
				partition by r.project_id
				order by (case when r.branch in ('main', 'master') then 0 else 1 end), r.started_at desc
			) as rn
			from runs r
			where ${scope('runs', 'r')}
		)
		select r.id, r.project_id, r.branch, r.commit_sha, r.status, r.source, r.tier, r.started_at, r.last_activity_at, r.reaped_at, r.finished_at
		from runs r
		join ranked k on k.id = r.id and k.rn = 1
		where ${scope('runs', 'r')}`

type Page<T> = { readonly items: readonly T[]; readonly next: string | null }

/** Every row of the pages `list` answers, in order. */
export const allRows = async <T>(list: (after: string | undefined) => Promise<Page<T>>): Promise<T[]> => {
	const rows: T[] = []
	let after: string | undefined
	do {
		const page = await list(after)
		rows.push(...page.items)
		after = page.next ?? undefined
	} while (after !== undefined)
	return rows
}

/**
 * The steps of a scenario's final attempt, from pages ordered by attempt descending: a retried scenario keeps its
 * earlier attempts' steps, which must not show beside the attempt that decided it.
 */
export const finalAttemptSteps = async <T extends { readonly attempt: number }>(
	list: (after: string | undefined) => Promise<Page<T>>,
): Promise<T[]> => {
	const rows: T[] = []
	let final: number | undefined
	let after: string | undefined
	do {
		const page = await list(after)
		for (const row of page.items) {
			final ??= row.attempt
			if (row.attempt !== final) {
				return rows
			}
			rows.push(row)
		}
		after = page.next ?? undefined
	} while (after !== undefined)
	return rows
}
