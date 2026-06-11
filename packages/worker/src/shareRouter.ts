import type { Capability } from '@propustka/client'
import { z } from 'zod'
import { capCanListRuns, capCanReadProject, capCanReadRun } from './principal'
import { ProjectSchema, RunSchema, ScenarioSchema, StepSchema } from './router'
import { initRpc, RpcDispatchError } from './rpc'
import type { Services } from './services'

/**
 * The PUBLIC, read-only share surface (`/s/rpc`). Its caller is an anonymous holder of a
 * propustka capability token (a run-share link, the agent read DSN, or the stage self-test),
 * redeemed by the Worker. Every gate is `cap.can(action, resource)` with the resource taken
 * from the request. There are NO mutations here and no operator identity.
 */
export interface ShareContext {
	services: Services
	cap: Capability
}

const rpc = initRpc<ShareContext>()

function forbidden(): never {
	throw new RpcDispatchError({ type: 'forbidden', message: 'forbidden', httpStatus: 403 })
}

function notFound(message: string): never {
	throw new RpcDispatchError({ type: 'not_found', message, httpStatus: 404 })
}

function assertAccess(ok: boolean): void {
	if (!ok) forbidden()
}

const RunPageSchema = z.object({ runs: z.array(RunSchema), hasMore: z.boolean() })

async function projectSlugForRun(services: Services, projectId: number): Promise<string | null> {
	const project = await services.db.getProjectById(projectId)
	return project?.slug ?? null
}

const projects = rpc.router({
	get: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(ProjectSchema)
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertAccess(capCanReadProject(ctx.cap, project.slug))
			return project
		}),
})

const runs = rpc.router({
	// Only a PROJECT-scoped read capability (agent read / self-test) can browse a run list;
	// a single run-share link cannot.
	listForProject: rpc.procedure
		.input(z.object({
			projectSlug: z.string(),
			limit: z.number().min(1).max(200).default(50),
			offset: z.number().min(0).default(0),
		}))
		.output(RunPageSchema)
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.projectSlug)
			if (!project) notFound(`Project not found: ${input.projectSlug}`)
			assertAccess(capCanListRuns(ctx.cap, project.slug))
			return ctx.services.db.listRunsForProject(project.id, { limit: input.limit, offset: input.offset })
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && capCanReadRun(ctx.cap, slug, run.id))
			return run
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && capCanReadRun(ctx.cap, slug, run.id))
			return ctx.services.db.listScenariosForRun(input.runId)
		}),
})

const scenarios = rpc.router({
	steps: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(z.array(StepSchema))
		.handler(async ({ ctx, input }) => {
			const scenario = await ctx.services.db.getScenario(input.scenarioId)
			if (!scenario) notFound(`Scenario not found: ${input.scenarioId}`)
			const run = await ctx.services.db.getRun(scenario.runId)
			if (!run) notFound(`Run not found: ${scenario.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && capCanReadRun(ctx.cap, slug, run.id))
			const rows = await ctx.services.db.listStepsForScenario(input.scenarioId)
			return rows.map(s => ({ ...s, screenshotUrl: s.screenshotKey ? `/s/screenshots/${s.screenshotKey}` : null }))
		}),
})

export const shareRouter = rpc.router({
	projects,
	runs,
	scenarios,
})

export type ShareRouter = typeof shareRouter
