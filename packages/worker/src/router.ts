import { z } from 'zod'
import type { Principal } from './principal'
import { canListRuns, canSeeProject, canSeeRun, generateSecret, generateTokenId, has, hashToken } from './principal'
import { initRpc, RpcDispatchError } from './rpc'
import type { Services } from './services'
import type { Capability } from './types'

export interface RpcContext {
	services: Services
	principal: Principal
}

const rpc = initRpc<RpcContext>()

function forbidden(message = 'forbidden'): never {
	throw new RpcDispatchError({ type: 'forbidden', message, httpStatus: 403 })
}

function notFound(message: string): never {
	throw new RpcDispatchError({ type: 'not_found', message, httpStatus: 404 })
}

function conflict(message: string): never {
	throw new RpcDispatchError({ type: 'conflict', message, httpStatus: 409 })
}

/** Gate a procedure on a capability; throws 403 when the principal lacks it. */
function requireCap(ctx: RpcContext, capability: Capability): void {
	if (!has(ctx.principal, capability)) forbidden()
}

function assertScope(ok: boolean): void {
	if (!ok) forbidden()
}

const StatusSchema = z.enum(['running', 'passed', 'failed'])
// Runs add the computed 'incomplete' display status (reaped / went stale).
const RunStatusSchema = z.enum(['running', 'passed', 'failed', 'incomplete'])

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

// A token, minus its hash — safe to return to the dashboard for management UI.
const TokenSummarySchema = z.object({
	id: z.string(),
	capability: z.enum(['read', 'write', 'admin']),
	projectSlug: z.string().nullable(),
	runId: z.string().nullable(),
	label: z.string().nullable(),
	createdAt: z.number(),
	expiresAt: z.number().nullable(),
	lastUsedAt: z.number().nullable(),
})

type TokenSummary = z.infer<typeof TokenSummarySchema>

function toTokenSummary(t: {
	id: string
	capability: Capability
	projectSlug: string | null
	runId: string | null
	label: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
}): TokenSummary {
	return {
		id: t.id,
		capability: t.capability,
		projectSlug: t.projectSlug,
		runId: t.runId,
		label: t.label,
		createdAt: t.createdAt,
		expiresAt: t.expiresAt,
		lastUsedAt: t.lastUsedAt,
	}
}

const projects = rpc.router({
	list: rpc.procedure
		.input(z.void())
		.output(z.array(ProjectSchema))
		.handler(async ({ ctx }) => {
			requireCap(ctx, 'read')
			const all = await ctx.services.db.listProjects()
			const scope = ctx.principal.scope
			return scope.kind === 'all' ? all : all.filter(p => p.id === scope.projectId)
		}),

	get: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(ProjectSchema)
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'read')
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertScope(canSeeProject(ctx.principal.scope, project.id))
			return project
		}),

	// Create a project + mint its ingest (write) key. Returns the api key *once*
	// — only its hash is stored, it's never readable again.
	create: rpc.procedure
		.input(z.object({
			slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers and dashes'),
			name: z.string().trim().min(1).max(120),
		}))
		.output(z.object({ slug: z.string(), name: z.string(), apiKey: z.string() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'write')
			if (await ctx.services.db.getProjectBySlug(input.slug)) conflict(`Project already exists: ${input.slug}`)
			const project = await ctx.services.db.createProject({ slug: input.slug, name: input.name })
			const apiKey = generateSecret()
			await ctx.services.db.createToken({
				id: generateTokenId(),
				tokenHash: await hashToken(apiKey),
				capability: 'write',
				projectId: project.id,
				label: 'ingest',
				createdBy: ctx.principal.subject,
			})
			return { slug: project.slug, name: project.name, apiKey }
		}),
})

const runs = rpc.router({
	listForProject: rpc.procedure
		.input(z.object({ projectSlug: z.string(), limit: z.number().min(1).max(200).default(50) }))
		.output(z.array(RunSchema))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'read')
			const project = await ctx.services.db.getProjectBySlug(input.projectSlug)
			if (!project) notFound(`Project not found: ${input.projectSlug}`)
			// A run-scoped share link can see its run but not the project's run list.
			assertScope(canListRuns(ctx.principal.scope, project.id))
			return ctx.services.db.listRunsForProject(project.id, input.limit)
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'read')
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			assertScope(canSeeRun(ctx.principal.scope, run.projectId, run.id))
			return run
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'read')
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			assertScope(canSeeRun(ctx.principal.scope, run.projectId, run.id))
			return ctx.services.db.listScenariosForRun(input.runId)
		}),
})

const scenarios = rpc.router({
	steps: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(z.array(StepSchema))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'read')
			const scenario = await ctx.services.db.getScenario(input.scenarioId)
			if (!scenario) notFound(`Scenario not found: ${input.scenarioId}`)
			const run = await ctx.services.db.getRun(scenario.runId)
			if (!run) notFound(`Run not found: ${scenario.runId}`)
			assertScope(canSeeRun(ctx.principal.scope, run.projectId, run.id))
			const rows = await ctx.services.db.listStepsForScenario(input.scenarioId)
			return rows.map(s => ({
				...s,
				screenshotUrl: s.screenshotKey ? `/screenshots/${s.screenshotKey}` : null,
			}))
		}),
})

// Run-scoped, read-only share links. Any operator (write capability) over the
// run's project can mint/list/revoke them — the replacement for the old
// per-project read token. The secret is returned once.
const shares = rpc.router({
	create: rpc.procedure
		.input(z.object({ runId: z.string(), expiresInDays: z.number().min(1).max(365).optional() }))
		.output(z.object({ token: z.string(), expiresAt: z.number().nullable() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'write')
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			assertScope(canListRuns(ctx.principal.scope, run.projectId))
			const token = generateSecret()
			const expiresAt = input.expiresInDays != null ? Date.now() + input.expiresInDays * 86_400_000 : null
			await ctx.services.db.createToken({
				id: generateTokenId(),
				tokenHash: await hashToken(token),
				capability: 'read',
				projectId: run.projectId,
				runId: run.id,
				label: 'share',
				createdBy: ctx.principal.subject,
				expiresAt,
			})
			return { token, expiresAt }
		}),

	list: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(TokenSummarySchema))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'write')
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			assertScope(canListRuns(ctx.principal.scope, run.projectId))
			const tokens = await ctx.services.db.listTokens(run.projectId)
			return tokens.filter(t => t.runId === run.id && t.capability === 'read').map(toTokenSummary)
		}),

	revoke: rpc.procedure
		.input(z.object({ tokenId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'write')
			const token = await ctx.services.db.getTokenById(input.tokenId)
			if (!token || token.projectId == null) notFound('share not found')
			assertScope(canListRuns(ctx.principal.scope, token.projectId))
			return { revoked: await ctx.services.db.revokeToken(token.id) }
		}),
})

// Operator-only: user accounts and the full token inventory (write/admin keys).
const admin = rpc.router({
	createUser: rpc.procedure
		.input(z.object({
			email: z.string().trim().email(),
			password: z.string().min(10),
			name: z.string().trim().min(1).optional(),
			role: z.enum(['admin', 'member']).default('admin'),
		}))
		.output(z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.string() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'admin')
			const name = input.name || input.email.split('@')[0] || input.email
			let userId: string
			let email: string
			let resolvedName: string
			try {
				const result = await ctx.services.auth.api.signUpEmail({ body: { email: input.email, password: input.password, name } })
				userId = result.user.id
				email = result.user.email
				resolvedName = result.user.name
			} catch (err) {
				const status = (err as { statusCode?: number }).statusCode
				const message = (err as { body?: { message?: string } }).body?.message ?? (err as Error).message ?? 'failed to create user'
				if (status === 422 || /exist/i.test(message)) conflict('a user with that email already exists')
				throw new RpcDispatchError({ type: 'validation', message, httpStatus: 400 })
			}
			// signUpEmail applies the plugin's defaultRole; set the requested role
			// explicitly (the only direct write to AUTH_DB outside the BetterAuth API).
			await ctx.services.authDb.prepare('UPDATE user SET role = ? WHERE id = ?').bind(input.role, userId).run()
			return { id: userId, email, name: resolvedName, role: input.role }
		}),

	listTokens: rpc.procedure
		.input(z.object({ projectSlug: z.string().optional() }))
		.output(z.array(TokenSummarySchema))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'admin')
			let projectId: number | null = null
			if (input.projectSlug) {
				const project = await ctx.services.db.getProjectBySlug(input.projectSlug)
				if (!project) notFound(`Project not found: ${input.projectSlug}`)
				projectId = project.id
			}
			const tokens = await ctx.services.db.listTokens(projectId)
			return tokens.map(toTokenSummary)
		}),

	// Mint a token. Project-scoped by default; omit `projectSlug` for a global,
	// read-all token (a "see everything" read link — e.g. the stage self-test).
	// Global tokens are read-only: a global write/admin secret is never minted here.
	createToken: rpc.procedure
		.input(z.object({
			projectSlug: z.string().optional(),
			capability: z.enum(['read', 'write']),
			label: z.string().trim().max(120).optional(),
			expiresInDays: z.number().min(1).max(3650).optional(),
		}))
		.output(z.object({ id: z.string(), token: z.string(), expiresAt: z.number().nullable() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'admin')
			let projectId: number | null = null
			if (input.projectSlug) {
				const project = await ctx.services.db.getProjectBySlug(input.projectSlug)
				if (!project) notFound(`Project not found: ${input.projectSlug}`)
				projectId = project.id
			} else if (input.capability !== 'read') {
				throw new RpcDispatchError({ type: 'validation', message: 'a global (project-less) token must be read-only', httpStatus: 400 })
			}
			const id = generateTokenId()
			const token = generateSecret()
			const expiresAt = input.expiresInDays != null ? Date.now() + input.expiresInDays * 86_400_000 : null
			await ctx.services.db.createToken({
				id,
				tokenHash: await hashToken(token),
				capability: input.capability,
				projectId,
				label: input.label ?? null,
				createdBy: ctx.principal.subject,
				expiresAt,
			})
			return { id, token, expiresAt }
		}),

	revokeToken: rpc.procedure
		.input(z.object({ tokenId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(async ({ ctx, input }) => {
			requireCap(ctx, 'admin')
			return { revoked: await ctx.services.db.revokeToken(input.tokenId) }
		}),
})

export const appRouter = rpc.router({
	projects,
	runs,
	scenarios,
	shares,
	admin,
})

export type AppRouter = typeof appRouter
