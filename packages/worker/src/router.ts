import { z } from 'zod'
import {
	type Caller,
	canListRuns,
	canProjectWrite,
	canSeeAllProjects,
	canSeeProject,
	canSeeRun,
	canTokenManage,
	generateSecret,
	generateTokenId,
	hashToken,
	operatorOf,
	subjectOf,
} from './principal'
import { initRpc, RpcDispatchError } from './rpc'
import type { Services } from './services'
import type { Capability } from './types'

export interface RpcContext {
	services: Services
	caller: Caller
	/** The original request — needed to forward the operator's Access credentials to propustka
	 * (issue / revoke capability tokens for run-shares). */
	request: Request
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

/** Throw 403 unless `ok`. The single gate primitive — handlers pass a caller-aware check. */
function assertAccess(ok: boolean): void {
	if (!ok) forbidden()
}

// Scenarios add the computed display statuses: 'warning' (a passed scenario
// carrying a tolerated fixme step) and 'incomplete' (one carrying a pending,
// unauthored step).
const StatusSchema = z.enum(['running', 'passed', 'failed', 'warning', 'incomplete'])
// Runs add 'incomplete' (reaped / went stale) and 'warning' — both computed.
const RunStatusSchema = z.enum(['running', 'passed', 'failed', 'incomplete', 'warning'])

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
	warningScenarios: z.number(),
	incompleteScenarios: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
})

// A run plus its project's slug + name, for the cross-project feed.
const RunWithProjectSchema = RunSchema.extend({
	projectSlug: z.string(),
	projectName: z.string(),
})

// A page of runs + whether another page exists (offset pagination).
const RunPageSchema = z.object({ runs: z.array(RunSchema), hasMore: z.boolean() })
const RunWithProjectPageSchema = z.object({ runs: z.array(RunWithProjectSchema), hasMore: z.boolean() })

const ScenarioSchema = z.object({
	id: z.string(),
	runId: z.string(),
	name: z.string(),
	hash: z.string().nullable(),
	testFile: z.string().nullable(),
	scenarioFile: z.string().nullable(),
	feature: z.string().nullable(),
	seeds: z.array(z.string()),
	roles: z.array(z.string()),
	status: StatusSchema,
	durationMs: z.number().nullable(),
	attempts: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
})

const StepSchema = z.object({
	id: z.number(),
	scenarioId: z.string(),
	attempt: z.number(),
	sequence: z.number(),
	kind: z.enum(['step', 'invariant']),
	name: z.string(),
	status: z.enum(['passed', 'failed', 'fixme', 'fixmepass', 'pending']),
	durationMs: z.number(),
	error: z.string().nullable(),
	intent: z.string().nullable(),
	manual: z.string().nullable(),
	reason: z.string().nullable(),
	screenshotUrl: z.string().nullable(),
	createdAt: z.number(),
})

// A data-plane token, minus its hash — safe to return to the dashboard's token manager.
const TokenSummarySchema = z.object({
	id: z.string(),
	capability: z.enum(['read', 'write', 'admin']),
	projectSlug: z.string().nullable(),
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
	label: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
}): TokenSummary {
	return {
		id: t.id,
		capability: t.capability,
		projectSlug: t.projectSlug,
		label: t.label,
		createdAt: t.createdAt,
		expiresAt: t.expiresAt,
		lastUsedAt: t.lastUsedAt,
	}
}

// A run-share, for the run page's share manager.
const ShareSummarySchema = z.object({
	id: z.string(),
	label: z.string().nullable(),
	createdAt: z.number(),
	expiresAt: z.number().nullable(),
})

// ── session ─────────────────────────────────────────────────────────────────────

// Who-am-I for the dashboard shell: identity + the operator capability flags it gates UI on.
// A share-link visitor (anonymous) is `authenticated: false` with every flag false — the SPA
// then renders the read-only run view without the operator chrome.
const session = rpc.router({
	me: rpc.procedure
		.input(z.void())
		.output(z.object({
			authenticated: z.boolean(),
			email: z.string().nullable(),
			canCreateProjects: z.boolean(),
			canManageTokens: z.boolean(),
		}))
		.handler(({ ctx }) => {
			const op = operatorOf(ctx.caller)
			if (!op) {
				return { authenticated: false, email: null, canCreateProjects: false, canManageTokens: false }
			}
			return {
				authenticated: true,
				email: op.principal.label,
				canCreateProjects: op.can('project.write'),
				canManageTokens: op.can('token.manage'),
			}
		}),
})

const projects = rpc.router({
	list: rpc.procedure
		.input(z.void())
		.output(z.array(ProjectSchema.extend({ lastRun: RunSchema.nullable() })))
		.handler(async ({ ctx }) => {
			const all = await ctx.services.db.listProjects()
			// Each caller kind sees only the projects it may read (operator scope / machine scope /
			// the share's own project).
			const visible = all.filter(p => canSeeProject(ctx.caller, p.slug))
			// Attach each project's headline run (latest on main/master, else latest)
			// so the list can show a status summary without a per-row request.
			const lastRuns = await ctx.services.db.listLastRunByProject()
			const byProject = new Map(lastRuns.map(r => [r.projectId, r]))
			return visible.map(p => ({ ...p, lastRun: byProject.get(p.id) ?? null }))
		}),

	get: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(ProjectSchema)
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertAccess(canSeeProject(ctx.caller, project.slug))
			return project
		}),

	// Create a project + mint two project-scoped DATA-PLANE keys: an ingest (write) key for
	// CI/local reporting, and a read key for an authoring agent to pull results back
	// (`OPICE_READ_DSN`). Both are app-local machine credentials (the Sentry-DSN plane) — they
	// do NOT live in IAM. Returned *once*; only their hashes are stored. Operator action.
	create: rpc.procedure
		.input(z.object({
			slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers and dashes'),
			name: z.string().trim().min(1).max(120),
		}))
		.output(z.object({ slug: z.string(), name: z.string(), apiKey: z.string(), readApiKey: z.string() }))
		.handler(async ({ ctx, input }) => {
			assertAccess(canProjectWrite(ctx.caller))
			if (await ctx.services.db.getProjectBySlug(input.slug)) conflict(`Project already exists: ${input.slug}`)
			const project = await ctx.services.db.createProject({ slug: input.slug, name: input.name })
			const createdBy = subjectOf(ctx.caller)
			const apiKey = generateSecret()
			await ctx.services.db.createToken({
				id: generateTokenId(),
				tokenHash: await hashToken(apiKey),
				capability: 'write',
				projectId: project.id,
				label: 'ingest',
				createdBy,
			})
			const readApiKey = generateSecret()
			await ctx.services.db.createToken({
				id: generateTokenId(),
				tokenHash: await hashToken(readApiKey),
				capability: 'read',
				projectId: project.id,
				label: 'agent-read',
				createdBy,
			})
			await operatorOf(ctx.caller)?.audit({
				action: 'project.create',
				resourceType: 'project',
				resourceId: project.slug,
				metadata: { name: project.name },
			})
			return { slug: project.slug, name: project.name, apiKey, readApiKey }
		}),
})

const runs = rpc.router({
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
			// A run-scoped share link can see its run but not the project's run list.
			assertAccess(canListRuns(ctx.caller, project.slug))
			return ctx.services.db.listRunsForProject(project.id, { limit: input.limit, offset: input.offset })
		}),

	// Cross-project feed — every project's runs, newest first. Only a global reader (an
	// app-wide operator, or a global read token) may browse it; a project- or run-scoped
	// credential is confined to its own project.
	listAll: rpc.procedure
		.input(z.object({
			limit: z.number().min(1).max(200).default(50),
			offset: z.number().min(0).default(0),
		}))
		.output(RunWithProjectPageSchema)
		.handler(async ({ ctx, input }) => {
			assertAccess(canSeeAllProjects(ctx.caller))
			return ctx.services.db.listAllRuns({ limit: input.limit, offset: input.offset })
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx, run.projectId)
			assertAccess(slug != null && canSeeRun(ctx.caller, slug, run.id))
			return run
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx, run.projectId)
			assertAccess(slug != null && canSeeRun(ctx.caller, slug, run.id))
			return ctx.services.db.listScenariosForRun(input.runId)
		}),
})

/** Resolve a run's project slug (the IAM project key) for scope checks. */
async function projectSlugForRun(ctx: RpcContext, projectId: number): Promise<string | null> {
	const project = await ctx.services.db.getProjectById(projectId)
	return project?.slug ?? null
}

const scenarios = rpc.router({
	steps: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(z.array(StepSchema))
		.handler(async ({ ctx, input }) => {
			const scenario = await ctx.services.db.getScenario(input.scenarioId)
			if (!scenario) notFound(`Scenario not found: ${input.scenarioId}`)
			const run = await ctx.services.db.getRun(scenario.runId)
			if (!run) notFound(`Run not found: ${scenario.runId}`)
			const slug = await projectSlugForRun(ctx, run.projectId)
			assertAccess(slug != null && canSeeRun(ctx.caller, slug, run.id))
			const rows = await ctx.services.db.listStepsForScenario(input.scenarioId)
			return rows.map(s => ({
				...s,
				screenshotUrl: s.screenshotKey ? `/screenshots/${s.screenshotKey}` : null,
			}))
		}),
})

// Run-scoped, read-only share links — propustka CAPABILITY tokens. Any operator with
// `project.write` over the run's project may mint/list/revoke them. opice keeps a local mirror
// (the `shares` table) so list/revoke have something to enumerate; the secret is returned once.
const shares = rpc.router({
	create: rpc.procedure
		.input(z.object({ runId: z.string(), expiresInDays: z.number().min(1).max(365).optional() }))
		.output(z.object({ token: z.string(), expiresAt: z.number().nullable() }))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const project = await ctx.services.db.getProjectById(run.projectId)
			if (!project) notFound(`Project not found for run: ${input.runId}`)
			assertAccess(canProjectWrite(ctx.caller, project.slug))

			const expiresAt = input.expiresInDays != null ? Date.now() + input.expiresInDays * 86_400_000 : null
			// Grant read on the run AND its project metadata (the share view shows the run + the
			// project name). projectId carries the slug for the delegation check (the issuer must
			// hold project.read on that project) — it is NOT stored on the capability.
			const issued = await ctx.services.iam.issueCapability(ctx.request, {
				grants: [
					{ action: 'project.read', resource: `run:${run.id}`, projectId: project.slug },
					{ action: 'project.read', resource: `project:${project.slug}`, projectId: project.slug },
				],
				label: `share:${project.slug}:${run.id}`,
				...(expiresAt != null ? { expiresAt } : {}),
			})
			if (!issued.ok) {
				// The issuer can't delegate read on this run — surface as forbidden.
				forbidden('not allowed to share this run')
			}
			await ctx.services.db.createShare({
				id: issued.id,
				runId: run.id,
				projectId: project.id,
				label: `share:${project.slug}:${run.id}`,
				createdBy: subjectOf(ctx.caller),
				expiresAt,
			})
			return { token: issued.token, expiresAt }
		}),

	list: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ShareSummarySchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const project = await ctx.services.db.getProjectById(run.projectId)
			if (!project) notFound(`Project not found for run: ${input.runId}`)
			assertAccess(canProjectWrite(ctx.caller, project.slug))
			const list = await ctx.services.db.listSharesForRun(run.id)
			return list.map(s => ({ id: s.id, label: s.label, createdAt: s.createdAt, expiresAt: s.expiresAt }))
		}),

	revoke: rpc.procedure
		.input(z.object({ shareId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(async ({ ctx, input }) => {
			const share = await ctx.services.db.getShare(input.shareId)
			if (!share) notFound('share not found')
			const project = await ctx.services.db.getProjectById(share.projectId)
			if (!project) notFound('share not found')
			assertAccess(canProjectWrite(ctx.caller, project.slug))
			// Hard revoke at the source (the token stops redeeming) THEN mirror the state locally.
			const result = await ctx.services.iam.revokeCapability(ctx.request, share.id)
			const mirrored = await ctx.services.db.markShareRevoked(share.id)
			await operatorOf(ctx.caller)?.audit({
				action: 'share.revoke',
				resourceType: 'capability',
				resourceId: share.id,
			})
			return { revoked: (result.ok && result.revoked) || mirrored }
		}),
})

// Operator-only: the DATA-PLANE token inventory (ingest / agent-read / global read keys).
// Gated on `token.manage` (admin). User accounts are gone — identity lives in IAM (Access).
const admin = rpc.router({
	listTokens: rpc.procedure
		.input(z.object({ projectSlug: z.string().optional() }))
		.output(z.array(TokenSummarySchema))
		.handler(async ({ ctx, input }) => {
			assertAccess(canTokenManage(ctx.caller))
			let projectId: number | null = null
			if (input.projectSlug) {
				const project = await ctx.services.db.getProjectBySlug(input.projectSlug)
				if (!project) notFound(`Project not found: ${input.projectSlug}`)
				projectId = project.id
			}
			const tokens = await ctx.services.db.listTokens(projectId)
			return tokens.map(toTokenSummary)
		}),

	// Mint a data-plane token. Project-scoped by default; omit `projectSlug` for a global,
	// read-all token (a "see everything" read key — e.g. the stage self-test). Global tokens
	// are read-only: a global write secret is never minted here.
	createToken: rpc.procedure
		.input(z.object({
			projectSlug: z.string().optional(),
			capability: z.enum(['read', 'write']),
			label: z.string().trim().max(120).optional(),
			expiresInDays: z.number().min(1).max(3650).optional(),
		}))
		.output(z.object({ id: z.string(), token: z.string(), expiresAt: z.number().nullable() }))
		.handler(async ({ ctx, input }) => {
			assertAccess(canTokenManage(ctx.caller))
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
				createdBy: subjectOf(ctx.caller),
				expiresAt,
			})
			return { id, token, expiresAt }
		}),

	revokeToken: rpc.procedure
		.input(z.object({ tokenId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(async ({ ctx, input }) => {
			assertAccess(canTokenManage(ctx.caller))
			return { revoked: await ctx.services.db.revokeToken(input.tokenId) }
		}),
})

export const appRouter = rpc.router({
	session,
	projects,
	runs,
	scenarios,
	shares,
	admin,
})

export type AppRouter = typeof appRouter
