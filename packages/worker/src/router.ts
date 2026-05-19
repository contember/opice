import { z } from 'zod'
import type { Db } from './db'
import { initRpc, RpcDispatchError } from './rpc'

export interface RpcContext {
	db: Db
}

const rpc = initRpc<RpcContext>()

const StatusSchema = z.enum(['running', 'passed', 'failed'])

const ProjectSchema = z.object({
	id: z.number(),
	slug: z.string(),
	name: z.string(),
	createdAt: z.number(),
})

const RunSchema = z.object({
	id: z.string(),
	projectId: z.number(),
	branch: z.string().nullable(),
	commitSha: z.string().nullable(),
	status: StatusSchema,
	totalScenarios: z.number(),
	passedScenarios: z.number(),
	failedScenarios: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
})

const ScenarioSchema = z.object({
	id: z.string(),
	runId: z.string(),
	name: z.string(),
	hash: z.string().nullable(),
	status: StatusSchema,
	durationMs: z.number().nullable(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
})

const StepSchema = z.object({
	id: z.number(),
	scenarioId: z.string(),
	sequence: z.number(),
	name: z.string(),
	status: z.enum(['passed', 'failed']),
	durationMs: z.number(),
	error: z.string().nullable(),
	screenshotUrl: z.string().nullable(),
	createdAt: z.number(),
})

const projects = rpc.router({
	list: rpc.procedure
		.input(z.void())
		.output(z.array(ProjectSchema))
		.handler(async ({ ctx }) => {
			const rows = await ctx.db.listProjects()
			return rows.map(p => ({
				id: p.id,
				slug: p.slug,
				name: p.name,
				createdAt: p.created_at,
			}))
		}),

	get: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(ProjectSchema)
		.handler(async ({ ctx, input }) => {
			const p = await ctx.db.getProjectBySlug(input.slug)
			if (!p) {
				throw new RpcDispatchError({ type: 'not_found', message: `Project not found: ${input.slug}`, httpStatus: 404 })
			}
			return { id: p.id, slug: p.slug, name: p.name, createdAt: p.created_at }
		}),
})

const runs = rpc.router({
	listForProject: rpc.procedure
		.input(z.object({ projectSlug: z.string(), limit: z.number().min(1).max(200).default(50) }))
		.output(z.array(RunSchema))
		.handler(async ({ ctx, input }) => {
			const project = await ctx.db.getProjectBySlug(input.projectSlug)
			if (!project) {
				throw new RpcDispatchError({ type: 'not_found', message: `Project not found: ${input.projectSlug}`, httpStatus: 404 })
			}
			const rows = await ctx.db.listRunsForProject(project.id, input.limit)
			return rows.map(serializeRun)
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			const run = await ctx.db.getRun(input.runId)
			if (!run) {
				throw new RpcDispatchError({ type: 'not_found', message: `Run not found: ${input.runId}`, httpStatus: 404 })
			}
			return serializeRun(run)
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			const rows = await ctx.db.listScenariosForRun(input.runId)
			return rows.map(s => ({
				id: s.id,
				runId: s.run_id,
				name: s.name,
				hash: s.hash,
				status: s.status,
				durationMs: s.duration_ms,
				startedAt: s.started_at,
				finishedAt: s.finished_at,
			}))
		}),
})

const scenarios = rpc.router({
	steps: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(z.array(StepSchema))
		.handler(async ({ ctx, input }) => {
			const rows = await ctx.db.listStepsForScenario(input.scenarioId)
			return rows.map(s => ({
				id: s.id,
				scenarioId: s.scenario_id,
				sequence: s.sequence,
				name: s.name,
				status: s.status,
				durationMs: s.duration_ms,
				error: s.error,
				screenshotUrl: s.screenshot_r2_key ? `/screenshots/${s.screenshot_r2_key}` : null,
				createdAt: s.created_at,
			}))
		}),
})

export const appRouter = rpc.router({
	projects,
	runs,
	scenarios,
})

export type AppRouter = typeof appRouter

function serializeRun(r: {
	id: string
	project_id: number
	branch: string | null
	commit_sha: string | null
	status: 'running' | 'passed' | 'failed'
	total_scenarios: number
	passed_scenarios: number
	failed_scenarios: number
	started_at: number
	finished_at: number | null
}) {
	return {
		id: r.id,
		projectId: r.project_id,
		branch: r.branch,
		commitSha: r.commit_sha,
		status: r.status,
		totalScenarios: r.total_scenarios,
		passedScenarios: r.passed_scenarios,
		failedScenarios: r.failed_scenarios,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
	}
}
