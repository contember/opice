import type { AuthContext, IssueCapabilityRequest } from '@propustka/client'
import { z } from 'zod'
import { withVideoUrl } from './asset-url'
import {
	opCanReadAll,
	opCanReadProject,
	opCanReadReports,
	opCanWriteProject,
} from './principal'
import { initRpc, RpcDispatchError } from './rpc'
import type { Services } from './services'

/** Operator RPC context — a human resolved through Cloudflare Access + propustka. */
export interface RpcContext {
	services: Services
	auth: AuthContext
	/** The original request — to forward the operator's Access credentials when minting/revoking capabilities. */
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

/** Throw 403 unless `ok`. The single gate primitive — handlers pass an `opCan*` check. */
function assertAccess(ok: boolean): void {
	if (!ok) forbidden()
}

// ── Schemas (shared with the share router) ──────────────────────────────────────

const StatusSchema = z.enum(['running', 'passed', 'failed', 'warning', 'incomplete', 'skipped'])
const RunStatusSchema = z.enum(['running', 'passed', 'failed', 'incomplete', 'warning'])

export const ProjectSchema = z.object({
	id: z.number(),
	slug: z.string(),
	name: z.string(),
	/** Branch allowed to write the impact index; null = main or master. */
	defaultBranch: z.string().nullable(),
	createdAt: z.number(),
})

export const RunSchema = z.object({
	id: z.string(),
	projectId: z.number(),
	branch: z.string().nullable(),
	commitSha: z.string().nullable(),
	status: RunStatusSchema,
	source: z.enum(['ci', 'local']).nullable(),
	tier: z.string().nullable(),
	totalScenarios: z.number(),
	passedScenarios: z.number(),
	failedScenarios: z.number(),
	warningScenarios: z.number(),
	incompleteScenarios: z.number(),
	skippedScenarios: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
})

const RunWithProjectSchema = RunSchema.extend({
	projectSlug: z.string(),
	projectName: z.string(),
})

const RunPageSchema = z.object({ runs: z.array(RunSchema), hasMore: z.boolean() })
const RunWithProjectPageSchema = z.object({ runs: z.array(RunWithProjectSchema), hasMore: z.boolean() })

/** Compact footprint counts carried on every scenario read. */
export const FootprintSummarySchema = z.object({
	files: z.number(),
	components: z.number(),
	endpoints: z.number(),
	models: z.number(),
	requests: z.number(),
	warnings: z.number(),
})

const FootprintOperationSchema = z.object({
	type: z.string(),
	name: z.string().optional(),
	rootFields: z.array(z.string()),
	models: z.array(z.object({ name: z.string(), write: z.boolean() })),
})

/**
 * One recorded request. Everything but the method and route has a default, so an
 * older blob still reads. Unknown keys are STRIPPED rather than passed through:
 * the stored document is written by `normalizeFootprint`'s allow-list, and
 * echoing anything beyond it would defeat that at the read end.
 */
const FootprintRequestSchema = z.object({
	step: z.number().nullable().default(null),
	method: z.string(),
	route: z.string(),
	params: z.array(z.string()).optional(),
	status: z.number().nullable().default(null),
	resourceType: z.string().default('other'),
	durationMs: z.number().nullable().default(null),
	operations: z.array(FootprintOperationSchema).optional(),
})

/** The full footprint blob, as stored in R2. */
export const ScenarioFootprintSchema = z.object({
	scenario: z.string(),
	testFile: z.string().optional(),
	collected: z.array(z.string()),
	files: z.array(z.object({ path: z.string(), source: z.string(), executed: z.number().optional() })),
	components: z.array(z.string()),
	requests: z.array(FootprintRequestSchema),
	endpoints: z.array(z.object({ route: z.string(), methods: z.array(z.string()), count: z.number() })),
	models: z.array(z.object({ name: z.string(), write: z.boolean() })),
	warnings: z.array(z.string()).optional(),
})

export type ScenarioFootprintDto = z.infer<typeof ScenarioFootprintSchema>

export const ScenarioSchema = z.object({
	id: z.string(),
	runId: z.string(),
	name: z.string(),
	hash: z.string().nullable(),
	testFile: z.string().nullable(),
	scenarioFile: z.string().nullable(),
	feature: z.string().nullable(),
	seeds: z.array(z.string()),
	roles: z.array(z.string()),
	tier: z.string().nullable(),
	skipReason: z.string().nullable(),
	status: StatusSchema,
	durationMs: z.number().nullable(),
	attempts: z.number(),
	startedAt: z.number(),
	finishedAt: z.number().nullable(),
	/** URL of the scenario's walkthrough video (opt-in OPICE_VIDEO), or null. */
	videoUrl: z.string().nullable(),
	/**
	 * Counts from the scenario's footprint (opt-in OPICE_FOOTPRINT), or null when
	 * it wasn't collected. The full detail lives in R2 and is fetched on demand
	 * via `scenarios.footprint` — a list view only ever needs the counts.
	 */
	footprint: FootprintSummarySchema.nullable(),
})

export const StepSchema = z.object({
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
	screenshotFailed: z.boolean(),
	createdAt: z.number(),
})

// A capability the dashboard can show + revoke (run-shares + project DSN keys).
const CapabilitySummarySchema = z.object({
	id: z.string(),
	kind: z.enum(['ingest', 'read', 'share']),
	runId: z.string().nullable(),
	label: z.string().nullable(),
	createdAt: z.number(),
	expiresAt: z.number().nullable(),
})

// ── session ─────────────────────────────────────────────────────────────────────

const session = rpc.router({
	me: rpc.procedure
		.input(z.void())
		.output(z.object({
			authenticated: z.literal(true),
			email: z.string(),
			canCreateProjects: z.boolean(),
		}))
		.handler(({ ctx }) => ({
			authenticated: true,
			email: ctx.auth.principal.label,
			// project.write held globally → may create projects + manage shares/keys.
			canCreateProjects: opCanWriteProject(ctx.auth),
		})),
})

const projects = rpc.router({
	list: rpc.procedure
		.input(z.void())
		.output(z.array(ProjectSchema.extend({ lastRun: RunSchema.nullable() })))
		.handler(async ({ ctx }) => {
			const all = await ctx.services.db.listProjects()
			const visible = all.filter(p => opCanReadProject(ctx.auth, p.slug))
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
			assertAccess(opCanReadProject(ctx.auth, project.slug))
			return project
		}),

	// Create a project + mint two project-scoped propustka SERVICE TOKENS: an ingest (report.write)
	// token for CI reporting (OPICE_DSN), and a read (report.read) token for an authoring agent /
	// the self-test to pull results back (OPICE_READ_DSN). The packed clientId:clientSecret is
	// returned ONCE; opice keeps only a metadata mirror (principal id/kind/clientId) for list+revoke.
	create: rpc.procedure
		.input(z.object({
			slug: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, numbers and dashes'),
			name: z.string().trim().min(1).max(120),
			/** Trunk name, when it isn't main or master — the branch allowed to write the impact index. */
			defaultBranch: z.string().trim().min(1).max(255).optional(),
		}))
		.output(z.object({ slug: z.string(), name: z.string(), apiKey: z.string(), readApiKey: z.string() }))
		.handler(async ({ ctx, input }) => {
			assertAccess(opCanWriteProject(ctx.auth))
			if (await ctx.services.db.getProjectBySlug(input.slug)) conflict(`Project already exists: ${input.slug}`)
			const project = await ctx.services.db.createProject({
				slug: input.slug,
				name: input.name,
				...(input.defaultBranch ? { defaultBranch: input.defaultBranch } : {}),
			})
			const apiKey = await mintServiceTokenDsn(ctx, project.id, project.slug, 'ingest')
			const readApiKey = await mintServiceTokenDsn(ctx, project.id, project.slug, 'read')
			await ctx.auth.audit({ action: 'project.create', resourceType: 'project', resourceId: project.slug, metadata: { name: project.name } })
			return { slug: project.slug, name: project.name, apiKey, readApiKey }
		}),

	/**
	 * Set the branch allowed to write the change-tracking index. Null restores the
	 * main-or-master default. Without this a project whose trunk is named anything
	 * else could never build an index at all.
	 */
	setDefaultBranch: rpc.procedure
		.input(z.object({ slug: z.string(), defaultBranch: z.string().trim().min(1).max(255).nullable() }))
		.output(z.object({ ok: z.literal(true) }))
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertAccess(opCanWriteProject(ctx.auth, project.slug))
			await ctx.services.db.setProjectDefaultBranch(project.id, input.defaultBranch)
			await ctx.auth.audit({
				action: 'project.update',
				resourceType: 'project',
				resourceId: project.slug,
				metadata: { defaultBranch: input.defaultBranch },
			})
			return { ok: true }
		}),

	// The project's live DSN capabilities (ingest + read), for a "keys" view — revocable.
	listKeys: rpc.procedure
		.input(z.object({ slug: z.string() }))
		.output(z.array(CapabilitySummarySchema))
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertAccess(opCanWriteProject(ctx.auth, project.slug))
			const list = await ctx.services.db.listProjectCapabilities(project.id)
			return list.filter(c => c.kind !== 'share').map(toCapabilitySummary)
		}),

	revokeKey: rpc.procedure
		.input(z.object({ capabilityId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(({ ctx, input }) => revokeMirroredCapability(ctx, input.capabilityId)),

	// Mint a fresh ingest/read DSN for an EXISTING project, revoking the prior live one of that
	// kind (rotation → at most one live ingest + one live read DSN per project). This is how you
	// (re-)provision a project's DSNs after the fact — e.g. every project's keys after migration
	// 0007 dropped the old `tokens` table. The token is returned ONCE.
	rotateKey: rpc.procedure
		.input(z.object({ slug: z.string(), kind: z.enum(['ingest', 'read']) }))
		.output(z.object({ token: z.string() }))
		.handler(async ({ ctx, input }) => {
			const project = await ctx.services.db.getProjectBySlug(input.slug)
			if (!project) notFound(`Project not found: ${input.slug}`)
			assertAccess(opCanWriteProject(ctx.auth, project.slug))
			for (const c of await ctx.services.db.listProjectCapabilities(project.id, input.kind)) {
				await ctx.services.iam.revokeServiceToken(ctx.request, c.id)
				await ctx.services.db.markCapabilityRevoked(c.id)
			}
			const token = await mintServiceTokenDsn(ctx, project.id, project.slug, input.kind)
			return { token }
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
			assertAccess(opCanReadReports(ctx.auth, project.slug))
			return ctx.services.db.listRunsForProject(project.id, { limit: input.limit, offset: input.offset })
		}),

	listAll: rpc.procedure
		.input(z.object({
			limit: z.number().min(1).max(200).default(50),
			offset: z.number().min(0).default(0),
		}))
		.output(RunWithProjectPageSchema)
		.handler(async ({ ctx, input }) => {
			assertAccess(opCanReadAll(ctx.auth))
			return ctx.services.db.listAllRuns({ limit: input.limit, offset: input.offset })
		}),

	get: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(RunSchema)
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && opCanReadReports(ctx.auth, slug))
			return run
		}),

	scenarios: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(ScenarioSchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && opCanReadReports(ctx.auth, slug))
			return withVideoUrl(await ctx.services.db.listScenariosForRun(input.runId), '/videos')
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
			assertAccess(slug != null && opCanReadReports(ctx.auth, slug))
			return mapSteps(await ctx.services.db.listStepsForScenario(input.scenarioId))
		}),

	/**
	 * The scenario's full footprint, read from R2 on demand.
	 *
	 * Not folded into the scenario read: a footprint is orders of magnitude
	 * bigger than the row that points at it, and a run page listing fifty
	 * scenarios would otherwise pull fifty blobs to render fifty badges. The
	 * counts on the row cover the list; this covers the panel you opened.
	 */
	footprint: rpc.procedure
		.input(z.object({ scenarioId: z.string() }))
		.output(ScenarioFootprintSchema.nullable())
		.handler(async ({ ctx, input }) => {
			const scenario = await ctx.services.db.getScenario(input.scenarioId)
			if (!scenario) notFound(`Scenario not found: ${input.scenarioId}`)
			const run = await ctx.services.db.getRun(scenario.runId)
			if (!run) notFound(`Run not found: ${scenario.runId}`)
			const slug = await projectSlugForRun(ctx.services, run.projectId)
			assertAccess(slug != null && opCanReadReports(ctx.auth, slug))
			return readFootprintBlob(ctx.services, scenario.footprintKey)
		})
})

// Run-scoped, read-only share links — propustka capability tokens. Any operator with
// `project.write` over the run's project may mint/list/revoke them. The secret is returned once.
const shares = rpc.router({
	create: rpc.procedure
		.input(z.object({ runId: z.string(), expiresInDays: z.number().min(1).max(365).optional() }))
		.output(z.object({ token: z.string(), expiresAt: z.number().nullable() }))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const project = await ctx.services.db.getProjectById(run.projectId)
			if (!project) notFound(`Project not found for run: ${input.runId}`)
			assertAccess(opCanWriteProject(ctx.auth, project.slug))
			const expiresAt = input.expiresInDays != null ? Date.now() + input.expiresInDays * 86_400_000 : null
			const token = await mintCapability(ctx, {
				projectId: project.id,
				runId: run.id,
				kind: 'share',
				label: `share:${project.slug}:${run.id}`,
				expiresAt,
				grants: [
					{ action: 'report.read', resource: `run:${run.id}`, scope: { type: 'project', value: project.slug } },
					{ action: 'project.read', resource: `project:${project.slug}`, scope: { type: 'project', value: project.slug } },
				],
			})
			return { token, expiresAt }
		}),

	list: rpc.procedure
		.input(z.object({ runId: z.string() }))
		.output(z.array(CapabilitySummarySchema))
		.handler(async ({ ctx, input }) => {
			const run = await ctx.services.db.getRun(input.runId)
			if (!run) notFound(`Run not found: ${input.runId}`)
			const project = await ctx.services.db.getProjectById(run.projectId)
			if (!project) notFound(`Project not found for run: ${input.runId}`)
			assertAccess(opCanWriteProject(ctx.auth, project.slug))
			return (await ctx.services.db.listRunShares(run.id)).map(toCapabilitySummary)
		}),

	revoke: rpc.procedure
		.input(z.object({ shareId: z.string() }))
		.output(z.object({ revoked: z.boolean() }))
		.handler(({ ctx, input }) => revokeMirroredCapability(ctx, input.shareId)),
})

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Resolve a run's project slug (the IAM project key) for scope checks. */
async function projectSlugForRun(services: Services, projectId: number): Promise<string | null> {
	const project = await services.db.getProjectById(projectId)
	return project?.slug ?? null
}

function mapSteps(rows: Awaited<ReturnType<Services['db']['listStepsForScenario']>>) {
	return rows.map(s => ({ ...s, screenshotUrl: s.screenshotKey ? `/screenshots/${s.screenshotKey}` : null }))
}

/**
 * Read a footprint blob out of R2. Shared by the operator and share routers.
 *
 * A missing or unparseable object reads as `null`, not an error: the scenario
 * row is the record that a footprint was collected, and the blob is best-effort
 * telemetry that may have failed to store. A 500 here would break a run page
 * over a panel that was always optional.
 */
export async function readFootprintBlob(services: Services, key: string | null): Promise<ScenarioFootprintDto | null> {
	if (!key) return null
	try {
		const object = await services.runAssets.get(key)
		if (!object) return null
		// Parse rather than cast. The blob was written by this worker, but a stored
		// object outlives the code that wrote it — this is where a footprint from
		// six months and three harness versions ago arrives.
		const parsed = ScenarioFootprintSchema.safeParse(JSON.parse(await object.text()))
		if (!parsed.success) {
			console.error(`footprint blob has an unexpected shape (${key}): ${parsed.error.message}`)
			return null
		}
		return parsed.data
	} catch (err) {
		console.error(`footprint blob unreadable (${key}): ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

interface MintInput {
	projectId: number
	runId?: string
	kind: 'ingest' | 'read' | 'share'
	label: string
	expiresAt?: number | null
	grants: IssueCapabilityRequest['grants']
}

/**
 * Mint a project's DSN as a propustka SERVICE TOKEN — ingest grants `report.write`, the agent read
 * grants `report.read` + `project.read`, both scoped to `project:<slug>`. The Worker mirrors the
 * service principal (id = principalId, clientId for display) so the dashboard can list + revoke,
 * and returns the packed `clientId:clientSecret` userinfo (the DSN's `https://<userinfo>@host/slug`).
 */
async function mintServiceTokenDsn(ctx: RpcContext, projectId: number, slug: string, kind: 'ingest' | 'read'): Promise<string> {
	const permissions = kind === 'ingest' ? ['report.write'] : ['report.read', 'project.read']
	const label = kind === 'ingest' ? `ingest:${slug}` : `agent-read:${slug}`
	const issued = await ctx.services.iam.issueServiceToken(ctx.request, {
		label,
		permissions,
		scope: { type: 'project', value: slug },
	})
	if (!issued.ok) forbidden('not allowed to mint this service token')
	await ctx.services.db.createCapability({
		id: issued.principalId,
		projectId,
		kind,
		label,
		clientId: issued.clientId,
		createdBy: ctx.auth.principal.id,
	})
	return `${issued.clientId}:${issued.clientSecret}`
}

/** Issue a propustka capability (operator delegates), mirror it locally, return the plaintext once. */
async function mintCapability(ctx: RpcContext, input: MintInput): Promise<string> {
	const issued = await ctx.services.iam.issueCapability(ctx.request, {
		grants: input.grants,
		label: input.label,
		...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
	})
	if (!issued.ok) forbidden('not allowed to mint this capability')
	await ctx.services.db.createCapability({
		id: issued.id,
		projectId: input.projectId,
		runId: input.runId ?? null,
		kind: input.kind,
		label: input.label,
		createdBy: ctx.auth.principal.id,
		expiresAt: input.expiresAt ?? null,
	})
	return issued.token
}

/** Hard-revoke a mirrored capability (propustka + the local mirror). Authorizes on project.write. */
async function revokeMirroredCapability(ctx: RpcContext, id: string): Promise<{ revoked: boolean }> {
	const record = await ctx.services.db.getCapability(id)
	if (!record) notFound('capability not found')
	const project = await ctx.services.db.getProjectById(record.projectId)
	if (!project) notFound('capability not found')
	assertAccess(opCanWriteProject(ctx.auth, project.slug))
	// share → a capability token (id = token id); ingest/read → a service token (id = principal id).
	const result = record.kind === 'share'
		? await ctx.services.iam.revokeCapability(ctx.request, id)
		: await ctx.services.iam.revokeServiceToken(ctx.request, id)
	const mirrored = await ctx.services.db.markCapabilityRevoked(id)
	await ctx.auth.audit({ action: 'capability.revoke', resourceType: 'capability', resourceId: id })
	return { revoked: (result.ok && result.revoked) || mirrored }
}

function toCapabilitySummary(c: { id: string; kind: 'ingest' | 'read' | 'share'; runId: string | null; label: string | null; createdAt: number; expiresAt: number | null }) {
	return { id: c.id, kind: c.kind, runId: c.runId, label: c.label, createdAt: c.createdAt, expiresAt: c.expiresAt }
}

export const appRouter = rpc.router({
	session,
	projects,
	runs,
	scenarios,
	shares,
})

export type AppRouter = typeof appRouter
