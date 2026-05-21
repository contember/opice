import { z } from 'zod'
import { generateApiKey, generateReadToken, hashApiKey } from './auth'
import type { Db } from './db'
import type { ReadScope } from './read-gate'
import { projectAllowed } from './read-gate'
import { initRpc, RpcDispatchError } from './rpc'

export interface RpcContext {
	db: Db
	scope: ReadScope
}

const rpc = initRpc<RpcContext>()

function forbidden(): never {
	throw new RpcDispatchError({ type: 'forbidden', message: 'forbidden', httpStatus: 403 })
}

function assertProjectAllowed(scope: ReadScope, projectId: number): void {
	if (!projectAllowed(scope, projectId)) forbidden()
}

const StatusSchema = z.enum(['running', 'passed', 'failed'])
// Runs add 'incomplete' — a computed display status for runs that never
// finished (reaped or stale). Scenarios never get it.
const RunStatusSchema = z.enum(['running', 'passed', 'failed', 'incomplete'])

const ProjectSchema = z.object({
	id: z.number(),
	slug: z.string(),
	name: z.string(),
	readToken: z.string().nullable(),
	createdAt: z.number(),
})

const RunSchema = z.object({
	id: z.string(),
	projectId: z.number(),
	branch: z.string().nullable(),
	commitSha: z.string().nullable(),
	status: RunStatusSchema,
	source: z.enum(['ci', 'local']).nullable(),
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
	testFile: z.string().nullable(),
	scenarioFile: z.string().nullable(),
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
			const all = await ctx.db.listProjects()
			// A project-scoped token only ever sees its own project.
			const scope = ctx.scope
			const visible = scope.kind === 'all' ? all : all.filter(p => p.id === scope.projectId)
			return visible.map(stripApiKey)
		}),

	get: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(ProjectSchema)
		.handler(async ({ ctx, input }) => {
			const project = await ctx.db.getProjectBySlug(input.slug)
			if (!project) {
				throw new RpcDispatchError({ type: 'not_found', message: `Project not found: ${input.slug}`, httpStatus: 404 })
			}
			assertProjectAllowed(ctx.scope, project.id)
			return stripApiKey(project)
		}),

	// Create a project from the dashboard. Owner-only (a logged-in session or
	// the global token resolves to `all`); project-scoped read tokens can't.
	// Returns the freshly-minted secrets *once* — the api key is never readable
	// again (only its hash is stored).
	create: rpc.procedure
		.input(z.object({
			slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers and dashes'),
			name: z.string().trim().min(1).max(120),
		}))
		.output(z.object({ slug: z.string(), name: z.string(), apiKey: z.string(), readToken: z.string() }))
		.handler(async ({ ctx, input }) => {
			if (ctx.scope.kind !== 'all') forbidden()
			const existing = await ctx.db.getProjectBySlug(input.slug)
			if (existing) {
				throw new RpcDispatchError({ type: 'conflict', message: `Project already exists: ${input.slug}`, httpStatus: 409 })
			}
			const apiKey = generateApiKey()
			const apiKeyHash = await hashApiKey(apiKey)
			const readToken = generateReadToken()
			const project = await ctx.db.createProject({ slug: input.slug, name: input.name, apiKeyHash, readToken })
			return { slug: project.slug, name: project.name, apiKey, readToken }
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
			assertProjectAllowed(ctx.scope, project.id)
			return ctx.db.listRunsForProject(project.id, input.limit)
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			const run = await ctx.db.getRun(input.runId)
			if (!run) {
				throw new RpcDispatchError({ type: 'not_found', message: `Run not found: ${input.runId}`, httpStatus: 404 })
			}
			assertProjectAllowed(ctx.scope, run.projectId)
			return run
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.db.getRun(input.runId)
			if (!run) {
				throw new RpcDispatchError({ type: 'not_found', message: `Run not found: ${input.runId}`, httpStatus: 404 })
			}
			assertProjectAllowed(ctx.scope, run.projectId)
			return ctx.db.listScenariosForRun(input.runId)
		}),
})

const scenarios = rpc.router({
	steps: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(z.array(StepSchema))
		.handler(async ({ ctx, input }) => {
			const scenario = await ctx.db.getScenario(input.scenarioId)
			if (!scenario) {
				throw new RpcDispatchError({ type: 'not_found', message: `Scenario not found: ${input.scenarioId}`, httpStatus: 404 })
			}
			const run = await ctx.db.getRun(scenario.runId)
			if (run) assertProjectAllowed(ctx.scope, run.projectId)
			const rows = await ctx.db.listStepsForScenario(input.scenarioId)
			return rows.map(s => ({
				...s,
				screenshotUrl: s.screenshotKey ? `/screenshots/${s.screenshotKey}` : null,
			}))
		}),
})

export const appRouter = rpc.router({
	projects,
	runs,
	scenarios,
})

export type AppRouter = typeof appRouter

function stripApiKey(p: { id: number; slug: string; name: string; readToken: string | null; createdAt: number }): {
	id: number
	slug: string
	name: string
	readToken: string | null
	createdAt: number
} {
	return { id: p.id, slug: p.slug, name: p.name, readToken: p.readToken, createdAt: p.createdAt }
}
