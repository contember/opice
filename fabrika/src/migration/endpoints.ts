// The one-off move of the previous platform's data, called by an import script with a key holding `data.import`:
// a project's creation time, then runs, scenarios and steps in batches with every stored value kept, then their screenshots. Each batch
// answers the new id of every row it inserted, keyed by the previous id. Remove this slice once the move is done.

import { BadRequestError } from '@fabrika/app'
import { file } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../app-kit'
import { Ok, RunSource, StepKind, StepStatus, StoredStatus } from '../schemas'

const MAX_JSON = 1048576

const Nullable = z.nullable(z.string().max(1000))
const Millis = z.int().min(0).max(1e13)
const IdMap = z.strictObject({ ids: z.array(z.strictObject({ from: z.string(), to: z.string() })) })

// IAM creates a project only for a person (a key cannot hold the creator role), so an operator creates each project
// in the dashboard under its old slug and name, and the import restores when it was created.
const ImportProject = z.strictObject({
	projectId: z.string().min(1).max(100),
	createdAt: Millis,
})

const ImportRuns = z.strictObject({
	projectId: z.string().min(1).max(100),
	runs: z.array(z.strictObject({
		from: z.string().min(1).max(100),
		branch: Nullable,
		commitSha: Nullable,
		status: StoredStatus,
		source: z.nullable(RunSource),
		tier: Nullable,
		totalScenarios: z.int().min(0),
		passedScenarios: z.int().min(0),
		failedScenarios: z.int().min(0),
		startedAt: Millis,
		lastActivityAt: z.nullable(Millis),
		reapedAt: z.nullable(Millis),
		finishedAt: z.nullable(Millis),
	})).max(500),
})

const ImportScenarios = z.strictObject({
	runId: z.string().min(1).max(100),
	scenarios: z.array(z.strictObject({
		from: z.string().min(1).max(100),
		name: z.string().min(1).max(1000),
		hash: Nullable,
		testFile: Nullable,
		scenarioFile: Nullable,
		feature: Nullable,
		seeds: z.nullable(z.string().max(20000)),
		roles: z.nullable(z.string().max(20000)),
		tier: Nullable,
		status: StoredStatus,
		durationMs: z.nullable(Millis),
		attempts: z.int().min(1),
		startedAt: Millis,
		finishedAt: z.nullable(Millis),
		skippedAt: z.nullable(Millis),
		skipReason: Nullable,
	})).max(500),
})

const ImportSteps = z.strictObject({
	runId: z.string().min(1).max(100),
	steps: z.array(z.strictObject({
		from: z.string().min(1).max(100),
		scenarioId: z.string().min(1).max(100),
		attempt: z.int().min(0),
		sequence: z.int().min(0),
		kind: StepKind,
		name: z.string().min(1).max(1000),
		status: StepStatus,
		durationMs: Millis,
		error: z.nullable(z.string().max(100000)),
		intent: Nullable,
		manual: Nullable,
		reason: Nullable,
		screenshotFailed: z.boolean(),
		createdAt: Millis,
	})).max(500),
})

const ImportScreenshots = z.strictObject({
	runId: z.string().min(1).max(100),
	stepIds: z.array(z.string().min(1).max(100)).max(20),
	files: z.optional(z.array(file('screenshots')).max(20)),
})

export const migration = app.group({ callers: ['machine'] }, (r) => ({
	project: r.mutation({
		input: ImportProject,
		output: Ok,
		access: { action: 'data.import', on: 'project', from: 'projectId' },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.update({ created_at: input.createdAt })
			return { ok: true as const }
		}),
	runs: r.mutation({
		input: ImportRuns,
		output: IdMap,
		access: { action: 'data.import', in: 'project', from: 'projectId' },
		limits: { maxBytes: MAX_JSON, timeoutMs: 20000 },
	})
		.handle(async ({ input, ctx }) => {
			const ids: { from: string; to: string }[] = []
			for (const run of input.runs) {
				const { id } = await ctx.db.target.runs.insert({
					branch: run.branch,
					commit_sha: run.commitSha,
					status: run.status,
					source: run.source,
					tier: run.tier,
					total_scenarios: run.totalScenarios,
					passed_scenarios: run.passedScenarios,
					failed_scenarios: run.failedScenarios,
					started_at: run.startedAt,
					last_activity_at: run.lastActivityAt,
					reaped_at: run.reapedAt,
					finished_at: run.finishedAt,
				})
				ids.push({ from: run.from, to: id })
			}
			return { ids }
		}),
	scenarios: r.mutation({
		input: ImportScenarios,
		output: IdMap,
		access: { action: 'data.import', on: 'run', from: 'runId' },
		limits: { maxBytes: MAX_JSON, timeoutMs: 20000 },
	})
		.handle(async ({ input, ctx }) => {
			const ids: { from: string; to: string }[] = []
			for (const scenario of input.scenarios) {
				const { id } = await ctx.db.target.scenarios.insert({
					name: scenario.name,
					hash: scenario.hash,
					test_file: scenario.testFile,
					scenario_file: scenario.scenarioFile,
					feature: scenario.feature,
					seeds: scenario.seeds,
					roles: scenario.roles,
					tier: scenario.tier,
					status: scenario.status,
					duration_ms: scenario.durationMs,
					attempts: scenario.attempts,
					started_at: scenario.startedAt,
					finished_at: scenario.finishedAt,
					skipped_at: scenario.skippedAt,
					skip_reason: scenario.skipReason,
				})
				ids.push({ from: scenario.from, to: id })
			}
			return { ids }
		}),
	steps: r.mutation({
		input: ImportSteps,
		output: IdMap,
		access: { action: 'data.import', on: 'run', from: 'runId' },
		limits: { maxBytes: MAX_JSON, timeoutMs: 20000 },
	})
		.handle(async ({ input, ctx }) => {
			const known = new Set<string>()
			const ids: { from: string; to: string }[] = []
			for (const step of input.steps) {
				// A step names its scenario by id; one of another run is 404, as in ingest.
				if (!known.has(step.scenarioId)) {
					await ctx.db.target.scenarios.get(step.scenarioId)
					known.add(step.scenarioId)
				}
				const { id } = await ctx.db.target.steps.insert({
					scenario_id: step.scenarioId,
					attempt: step.attempt,
					sequence: step.sequence,
					kind: step.kind,
					name: step.name,
					status: step.status,
					duration_ms: step.durationMs,
					error: step.error,
					intent: step.intent,
					manual: step.manual,
					reason: step.reason,
					screenshot: null,
					screenshot_failed: step.screenshotFailed,
					created_at: step.createdAt,
				})
				ids.push({ from: step.from, to: id })
			}
			return { ids }
		}),
	screenshots: r.mutation({
		input: ImportScreenshots,
		output: Ok,
		access: { action: 'data.import', on: 'run', from: 'runId' },
		limits: { timeoutMs: 20000 },
	})
		.handle(async ({ input, ctx }) => {
			const files = input.files ?? []
			if (input.stepIds.length !== files.length) {
				throw new BadRequestError('stepIds and files pair by position: send as many of each')
			}
			for (const [index, stepId] of input.stepIds.entries()) {
				const screenshot = files[index]
				if (screenshot !== undefined) {
					await ctx.db.target.steps.update(stepId, { screenshot })
				}
			}
			return { ok: true as const }
		}),
}))
