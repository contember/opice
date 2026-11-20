// The whole reporting surface, one slice over one schema:
// - CI, with a service key of one project, reports runs, scenarios and steps with their files, and reads them back;
// - an operator reads projects and runs in the dashboard and shares a run by link (keys are minted in the console);
// - a link holder reads the one run it was given;
// - a job marks runs abandoned mid-flight.

import { ConflictError, fromRow, NotFoundError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import {
	ByRun,
	ByRunScenario,
	ByRunStep,
	Ok,
	Project,
	ProjectWithLastRun,
	Run,
	RunPage,
	RunSource,
	RunWithProjectPage,
	Scenarios,
	ShareSummary,
	StepKind,
	StepStatus,
	Steps,
} from '../schemas'
import { attemptOf, attemptsOf, encodeList, finishedRunStatus, isStale } from './logic'
import {
	allRows,
	allRuns,
	finalAttemptSteps,
	finishCounts,
	headlineRuns,
	nextSequence,
	projectRuns,
	runCounts,
	scenarioFlags,
} from './queries'
import { storedRun, toRun, toRunWithProject, toScenario, toStep } from './views'

const Text = z.string().max(1000)
const LongText = z.string().max(100_000)
const Names = z.array(z.string().max(200)).max(100)
const Millis = z.number().min(0).max(1e12)

const StartRun = z.strictObject({
	projectId: z.string().min(1).max(100),
	branch: Text.optional(),
	commit: Text.optional(),
	source: RunSource.optional(),
	tier: Text.optional(),
})
const RunStarted = z.strictObject({ runId: z.string() })

const StartScenario = z.strictObject({
	runId: z.string().min(1).max(100),
	name: z.string().min(1).max(1000),
	hash: Text.optional(),
	testFile: Text.optional(),
	scenarioFile: Text.optional(),
	feature: Text.optional(),
	seeds: Names.optional(),
	roles: Names.optional(),
	tier: Text.optional(),
	skipped: z.boolean().optional(),
	reason: Text.optional(),
})
const ScenarioStarted = z.strictObject({ scenarioId: z.string() })

const FinishScenario = z.strictObject({
	runId: z.string().min(1).max(100),
	scenarioId: z.string().min(1).max(100),
	status: z.enum(['passed', 'failed']),
	durationMs: Millis,
	attempts: z.int().min(0).max(1000).optional(),
})

const ReportStep = z.strictObject({
	runId: z.string().min(1).max(100),
	scenarioId: z.string().min(1).max(100),
	attempt: z.int().min(0).max(1000).optional(),
	sequence: z.int().min(0).max(1_000_000).optional(),
	kind: StepKind.optional(),
	name: z.string().min(1).max(1000),
	status: StepStatus,
	durationMs: Millis,
	error: LongText.optional(),
	intent: Text.optional(),
	manual: Text.optional(),
	reason: Text.optional(),
	screenshotFailed: z.boolean().optional(),
	screenshot: z.optional(file('screenshots')),
})
const StepReported = z.strictObject({ stepId: z.string(), screenshotFailed: z.boolean() })

export const reports = app.group({ callers: ['machine'] }, (r) => ({
	startRun: r.mutation({
		input: StartRun,
		output: RunStarted,
		access: { action: 'report.write', in: 'project', from: 'projectId' },
	})
		.handle(async ({ input, ctx }) => {
			const now = Date.now()
			const { id } = await ctx.db.target.runs.insert({
				branch: input.branch ?? null,
				commit_sha: input.commit ?? null,
				status: 'running',
				source: input.source ?? null,
				tier: input.tier ?? null,
				started_at: now,
				last_activity_at: now,
			})
			return { runId: id }
		}),
	startScenario: r.mutation({
		input: StartScenario,
		output: ScenarioStarted,
		access: { action: 'report.write', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			const now = Date.now()
			// A skipped scenario never runs: it is finished when it is created.
			const skippedAt = input.skipped === true ? now : null
			await touch(ctx.db.target, now)
			const { id } = await ctx.db.target.scenarios.insert({
				name: input.name,
				hash: input.hash ?? null,
				test_file: input.testFile ?? null,
				scenario_file: input.scenarioFile ?? null,
				feature: input.feature ?? null,
				seeds: encodeList(input.seeds),
				roles: encodeList(input.roles),
				tier: input.tier ?? null,
				status: 'running',
				started_at: now,
				skipped_at: skippedAt,
				skip_reason: input.skipped === true ? (input.reason ?? null) : null,
				finished_at: skippedAt,
			})
			return { scenarioId: id }
		}),
	finishScenario: r.mutation({
		input: FinishScenario,
		output: Ok,
		access: { action: 'report.write', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			const now = Date.now()
			await touch(ctx.db.target, now)
			await ctx.db.target.scenarios.update(input.scenarioId, {
				status: input.status,
				duration_ms: Math.round(input.durationMs),
				attempts: attemptsOf(input.attempts),
				finished_at: now,
			})
			return { ok: true as const }
		}),
	step: r.mutation({
		input: ReportStep,
		output: StepReported,
		access: { action: 'report.write', on: 'run', from: 'runId' },
		sql: 'read',
		limits: { timeoutMs: 20_000 },
	})
		.handle(async ({ input, ctx }) => {
			const now = Date.now()
			await ctx.db.target.scenarios.get(input.scenarioId)
			await touch(ctx.db.target, now)
			const attempt = attemptOf(input.attempt)
			const sequence = input.sequence
				?? await nextSequence(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), input.scenarioId, attempt)
			const { id } = await ctx.db.target.steps.insert({
				scenario_id: input.scenarioId,
				attempt,
				sequence,
				kind: input.kind ?? 'step',
				name: input.name,
				status: input.status,
				duration_ms: Math.round(input.durationMs),
				error: input.error ?? null,
				intent: input.intent ?? null,
				manual: input.manual ?? null,
				reason: input.reason ?? null,
				screenshot: input.screenshot ?? null,
				screenshot_failed: input.screenshotFailed === true,
				created_at: now,
			})
			return { stepId: id, screenshotFailed: input.screenshotFailed === true }
		}),
	finishRun: r.mutation({
		input: ByRun,
		output: Ok,
		access: { action: 'report.write', on: 'run', from: 'runId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const counts = await finishCounts(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), ctx.target.value)
			await ctx.db.target.update({
				status: finishedRunStatus(counts),
				total_scenarios: counts.executed,
				passed_scenarios: counts.passed,
				failed_scenarios: counts.failed,
				finished_at: Date.now(),
			})
			return { ok: true as const }
		}),
}))

export const reads = app.group({ callers: ['machine'] }, (r) => ({
	run: r.query({
		input: ByRun,
		output: Run,
		access: { action: 'report.read', on: 'run', from: 'runId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const row = storedRun(await ctx.db.target.get())
			const counts = await runCounts(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), [row.id])
			return toRun(row, counts.get(row.id), Date.now())
		}),
	scenarios: r.query({
		input: ByRun,
		output: Scenarios,
		access: { action: 'report.read', on: 'run', from: 'runId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const flags = await scenarioFlags(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), ctx.target.value)
			const rows = await allRows((after) => ctx.db.target.scenarios.list({ orderBy: [['started_at', 'asc']], limit: 500, after }))
			return {
				scenarios: rows.map((row) =>
toScenario(row, flags.get(row.id))
				),
			}
		}),
	steps: r.query({
		input: ByRunScenario,
		output: Steps,
		access: { action: 'report.read', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.scenarios.get(input.scenarioId)
			const rows = await finalAttemptSteps((after) =>
				ctx.db.target.steps.list({ where: [['scenario_id', '=', input.scenarioId]], orderBy: [['attempt', 'desc'], ['sequence', 'asc']], limit: 500, after })
			)
			return {
				steps: rows.map((row) =>
					toStep(row, row.screenshot === null ? null : ctx.url('machine.reads.screenshot', { input: { runId: ctx.target.value, stepId: row.id } }))
				),
			}
		}),
	screenshot: r.query({
		input: ByRunStep,
		output: file('screenshots'),
		access: { action: 'report.read', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			const step = await ctx.db.target.steps.get(input.stepId)
			if (step.screenshot === null) {
				throw new NotFoundError('the step has no screenshot')
			}
			return step.screenshot
		}),
}))

/** Every scenario or step write is a heartbeat, so the reaper leaves a run in flight alone. */
const touch = async (
	run: { getForUpdate(): Promise<{ readonly finished_at: number | null }>; update(values: { last_activity_at: number }): Promise<unknown> },
	now: number,
): Promise<void> => {
	const current = await run.getForUpdate()
	if (current.finished_at === null) {
		await run.update({ last_activity_at: now })
	}
}

const Me = z.strictObject({ authenticated: z.literal(true), email: z.string() })
const Projects = z.strictObject({ projects: z.array(ProjectWithLastRun) })
const BySlug = z.strictObject({ slug: z.string().min(1).max(64) })
const FoundProject = z.strictObject({ project: z.nullable(Project) })
const NewProject = z.strictObject({
	slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
	name: z.string().min(1).max(120),
})
const Paging = z.strictObject({
	limit: z.int().min(1).max(200).optional(),
	offset: z.int().min(0).max(1_000_000).optional(),
})
const ProjectPaging = z.strictObject({
	projectId: z.string().min(1).max(100),
	limit: z.int().min(1).max(200).optional(),
	offset: z.int().min(0).max(1_000_000).optional(),
})
const NewShare = z.strictObject({ runId: z.string().min(1).max(100), expiresInDays: z.int().min(1).max(365).optional() })
const Shared = z.strictObject({ url: z.string(), expiresAt: z.int() })
const Shares = z.strictObject({ shares: z.array(ShareSummary) })
const RevokeShare = z.strictObject({ runId: z.string().min(1).max(100), linkId: z.string().min(1).max(200) })
const Revoked = z.strictObject({ revoked: z.boolean() })

const DEFAULT_SHARE_DAYS = 30

export const session = app.group({ callers: ['human'] }, (r) => ({
	me: r.query({ output: Me, access: { member: true } })
		.handle(({ ctx }) => ({ authenticated: true as const, email: ctx.principal.email ?? ctx.principal.label })),
}))

export const projects = app.group({ callers: ['human'] }, (r) => ({
	list: r.query({
		output: Projects,
		access: { action: 'report.read', over: 'project' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const scope = (table: 'runs' | 'scenarios' | 'steps', alias: string) => ctx.sql.scope(ctx.within, table, { alias })
			const rows = await allRows((after) => ctx.db.within.projects.list({ orderBy: [['created_at', 'desc']], limit: 500, after }))
			const headlines = await headlineRuns(ctx.sql, scope)
			const counts = await runCounts(ctx.sql, scope, headlines.map((run) => run.id))
			const now = Date.now()
			const byProject = new Map(headlines.map((run) => [run.projectId, toRun(run, counts.get(run.id), now)]))
			return {
				projects: rows.map((row) => ({ ...fromRow(Project, row), lastRun: byProject.get(row.id) ?? null })),
			}
		}),
	get: r.query({
		input: BySlug,
		output: FoundProject,
		access: { action: 'project.read', over: 'project' },
	})
		.handle(async ({ input, ctx }) => {
			// A dashboard URL names a project by its slug; the CLI's run link names it by its id.
			const [bySlug] = (await ctx.db.within.projects.list({ where: [['slug', '=', input.slug]], limit: 1 })).items
			const [row] = bySlug === undefined ? (await ctx.db.within.projects.list({ where: [['id', '=', input.slug]], limit: 1 })).items : [bySlug]
			return { project: row === undefined ? null : fromRow(Project, row) }
		}),
	create: r.mutation({
		input: NewProject,
		output: Project,
		access: { action: 'project.write', creates: 'project' },
		unscoped: { projects: 'read' },
	})
		.handle(async ({ input, ctx }) => {
			// The slug names the project in URLs, across every project, including those the caller does not read.
			if ((await ctx.db.unscoped.projects.count({ where: [['slug', '=', input.slug]] })) > 0) {
				throw new ConflictError(`Project already exists: ${input.slug}`)
			}
			const createdAt = Date.now()
			const { id } = await ctx.db.created.projects.insert({ slug: input.slug, name: input.name, created_at: createdAt })
			return { id, slug: input.slug, name: input.name, createdAt }
		}),
}))

export const runs = app.group({ callers: ['human'] }, (r) => ({
	listForProject: r.query({
		input: ProjectPaging,
		output: RunPage,
		access: { action: 'report.read', in: 'project', from: 'projectId' },
		sql: 'read',
	})
		.handle(async ({ input, ctx }) => {
			const limit = input.limit ?? 50
			const scope = (table: 'runs' | 'scenarios' | 'steps', alias: string) => ctx.sql.scope(ctx.target, table, { alias })
			const rows = await projectRuns(ctx.sql, scope, limit, input.offset ?? 0)
			const page = rows.slice(0, limit)
			const counts = await runCounts(ctx.sql, scope, page.map((run) => run.id))
			const now = Date.now()
			return { runs: page.map((run) => toRun(run, counts.get(run.id), now)), hasMore: rows.length > limit }
		}),
	listAll: r.query({
		input: Paging,
		output: RunWithProjectPage,
		access: { action: 'report.read', over: 'project' },
		sql: 'read',
	})
		.handle(async ({ input, ctx }) => {
			const limit = input.limit ?? 50
			const scope = (table: 'runs' | 'scenarios' | 'steps', alias: string) => ctx.sql.scope(ctx.within, table, { alias })
			const rows = await allRuns(ctx.sql, scope, ctx.sql.scope(ctx.within, 'projects', { alias: 'p' }), limit, input.offset ?? 0)
			const page = rows.slice(0, limit)
			const counts = await runCounts(ctx.sql, scope, page.map((run) => run.id))
			const now = Date.now()
			return { runs: page.map((run) => toRunWithProject(run, counts.get(run.id), now)), hasMore: rows.length > limit }
		}),
	get: r.query({
		input: ByRun,
		output: Run,
		access: { action: 'report.read', on: 'run', from: 'runId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const row = storedRun(await ctx.db.target.get())
			const counts = await runCounts(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), [row.id])
			return toRun(row, counts.get(row.id), Date.now())
		}),
	scenarios: r.query({
		input: ByRun,
		output: Scenarios,
		access: { action: 'report.read', on: 'run', from: 'runId' },
		sql: 'read',
	})
		.handle(async ({ ctx }) => {
			const runId = ctx.target.value
			const flags = await scenarioFlags(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), runId)
			const rows = await allRows((after) => ctx.db.target.scenarios.list({ orderBy: [['started_at', 'asc']], limit: 500, after }))
			return {
				scenarios: rows.map((row) =>
					toScenario(row, flags.get(row.id))
				),
			}
		}),
	steps: r.query({
		input: ByRunScenario,
		output: Steps,
		access: { action: 'report.read', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			const runId = ctx.target.value
			await ctx.db.target.scenarios.get(input.scenarioId)
			const rows = await finalAttemptSteps((after) =>
				ctx.db.target.steps.list({ where: [['scenario_id', '=', input.scenarioId]], orderBy: [['attempt', 'desc'], ['sequence', 'asc']], limit: 500, after })
			)
			return {
				steps: rows.map((row) =>
					toStep(row, row.screenshot === null ? null : ctx.url('api.runs.screenshot', { input: { runId, stepId: row.id } }))
				),
			}
		}),
	screenshot: r.query({
		input: ByRunStep,
		output: file('screenshots'),
		access: { action: 'report.read', on: 'run', from: 'runId' },
	})
		.handle(async ({ input, ctx }) => {
			const step = await ctx.db.target.steps.get(input.stepId)
			if (step.screenshot === null) {
				throw new NotFoundError('the step has no screenshot')
			}
			return step.screenshot
		}),
}))

export const shares = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: NewShare,
		output: Shared,
		access: { action: 'project.write', on: 'run', from: 'runId' },
		issues: 'shared',
	})
		.handle(async ({ input, ctx }) => {
			const days = input.expiresInDays ?? DEFAULT_SHARE_DAYS
			const now = Date.now()
			// IAM does not roll back with the transaction: a link whose row fails to commit is listed nowhere and expires.
			const link = await ctx.links.issue(ctx.target, { mount: 'shared', days })
			// IAM answers the expiry in Unix seconds; rows keep milliseconds.
			const expiresAt = link.expiresAt * 1000
			await ctx.db.target.run_shares.insert({ link_id: link.id, created_at: now, expires_at: expiresAt })
			return { url: link.url, expiresAt }
		}),
	list: r.query({
		input: ByRun,
		output: Shares,
		access: { action: 'project.write', on: 'run', from: 'runId' },
	})
		.handle(async ({ ctx }) => {
			const now = Date.now()
			const rows = await allRows((after) => ctx.db.target.run_shares.list({ orderBy: [['created_at', 'desc']], limit: 500, after }))
			return {
				shares: rows
					.filter((row) => row.revoked_at === null && row.expires_at > now)
					.map((row) => ({ id: row.link_id, runId: row.run_id, createdAt: row.created_at, expiresAt: row.expires_at })),
			}
		}),
	revoke: r.mutation({
		input: RevokeShare,
		output: Revoked,
		access: { action: 'project.write', on: 'run', from: 'runId' },
		issues: 'shared',
	})
		.handle(async ({ input, ctx }) => {
			const now = Date.now()
			const recorded = await allRows((after) =>
				ctx.db.target.run_shares.list({ where: [['link_id', '=', input.linkId]], limit: 500, after })
			)
			// Only a link this run recorded is revoked here, so a link id of another run never reaches IAM through it.
			if (recorded.length === 0) {
				throw new NotFoundError('this run has no such share link')
			}
			const live = recorded.filter((share) => share.revoked_at === null)
			for (const share of live) {
				await ctx.db.target.run_shares.update(share.id, { revoked_at: now })
			}
			// IAM refuses a link the caller neither issued nor manages; revoking one again answers the same.
			await ctx.links.revoke(input.linkId)
			return { revoked: live.length > 0 }
		}),
}))


const ByScenario = z.strictObject({ scenarioId: z.string().min(1).max(100) })
const ByStep = z.strictObject({ stepId: z.string().min(1).max(100) })

export const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'run',
	grants: ['report.read'],
	issuedBy: 'project.write',
	maxDays: 365,
	procedures: (l) => ({
		run: l.query({ output: Run, access: { action: 'report.read' }, sql: 'read' })
			.handle(async ({ ctx }) => {
				const row = storedRun(await ctx.db.target.get())
				const counts = await runCounts(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), [row.id])
				return toRun(row, counts.get(row.id), Date.now())
			}),
		scenarios: l.query({ output: Scenarios, access: { action: 'report.read' }, sql: 'read' })
			.handle(async ({ ctx }) => {
				const flags = await scenarioFlags(ctx.sql, (table, alias) => ctx.sql.scope(ctx.target, table, { alias }), ctx.target.value)
				const rows = await allRows((after) => ctx.db.target.scenarios.list({ orderBy: [['started_at', 'asc']], limit: 500, after }))
				return {
					scenarios: rows.map((row) =>
						toScenario(row, flags.get(row.id))
					),
				}
			}),
		steps: l.query({ input: ByScenario, output: Steps, access: { action: 'report.read' } })
			.handle(async ({ input, ctx }) => {
				await ctx.db.target.scenarios.get(input.scenarioId)
				const rows = await finalAttemptSteps((after) =>
					ctx.db.target.steps.list({ where: [['scenario_id', '=', input.scenarioId]], orderBy: [['attempt', 'desc'], ['sequence', 'asc']], limit: 500, after })
				)
				return {
					steps: rows.map((row) =>
						toStep(row, row.screenshot === null ? null : ctx.url('shared.screenshot', { input: { stepId: row.id } }))
					),
				}
			}),
		screenshot: l.query({ input: ByStep, output: file('screenshots'), access: { action: 'report.read' } })
			.handle(async ({ input, ctx }) => {
				const step = await ctx.db.target.steps.get(input.stepId)
				if (step.screenshot === null) {
					throw new NotFoundError('the step has no screenshot')
				}
				return step.screenshot
			}),
	}),
})

export const reapStaleRuns = app.cron('*/5 * * * *', { actions: ['report.write'], limits: { timeoutMs: 600000 } })
	.handle(async ({ ctx }) => {
		const now = Date.now()
		const runs = ctx.db.over(ctx.within('report.write', 'project')).runs
		let after: string | undefined
		do {
			const page = await runs.list({
				where: [
					['status', '=', 'running'],
					['reaped_at', 'is', null],
					['finished_at', 'is', null],
				],
				limit: 500,
				after,
			})
			for (const listed of page.items) {
				if (!isStale(storedRun(listed), now)) {
					continue
				}
				const ref = await ctx.ref('report.write', 'run', listed.id)
				await ctx.transaction(async (tx) => {
					const run = await tx.db.on(ref).getForUpdate()
					if (run.reaped_at === null && run.finished_at === null && isStale(storedRun(run), now)) {
						await tx.db.on(ref).update({ reaped_at: now, finished_at: now })
					}
				})
			}
			after = page.next ?? undefined
		} while (after !== undefined)
	})
