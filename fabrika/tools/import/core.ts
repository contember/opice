// The one-off move of the previous platform's data through the `migration.*` procedures. Projects first (their
// creation time, then their runs), then each run on its own: scenarios, steps, screenshots. Every answered batch is
// recorded in the state before the next request, so a rerun continues where the last one stopped and never inserts a
// row twice. An insert whose outcome is unknown (the connection dropped, a gateway answered) stops the import: the
// rows may or may not be in, so the run is marked and left to the operator (`retryUncertain`).

import { createClient, RpcError, type RpcFetch } from '@fabrika/app/client'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import type { Source, SourceRun, SourceScenario, SourceStep } from './source'

export const MAX_ROWS = 500
/** A batch's JSON stays well under the procedures' 1 MiB body limit. */
export const MAX_BATCH_BYTES = 900_000
export const MAX_FILES = 20
/** The `screenshots` file kind's cap. */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_FILES_BYTES = 40 * 1024 * 1024
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const machineClient = (options: { baseUrl?: string; key: string; fetch: RpcFetch }) =>
	createClient(contract, 'machine', options)
type MigrationClient = ReturnType<typeof machineClient>['migration']

export interface ObjectSource {
	/** The object's bytes, or `null` when the bucket has no such key. */
	get(key: string): Promise<Uint8Array<ArrayBuffer> | null>
}

// ---------------------------------------------------------------------------------------------------------------
// The state: ids and cursors only, never row content or a credential.

const RunState = z.strictObject({
	to: z.string(),
	scenariosAfter: z.nullable(z.string()),
	scenarios: z.record(z.string(), z.string()),
	stepsAfter: z.nullable(z.number()),
	/** Old step id → new id, only for the steps whose screenshot is copied. */
	steps: z.record(z.string(), z.string()),
	shotsAfter: z.nullable(z.number()),
	done: z.boolean(),
	uncertain: z.nullable(z.string()),
})
type RunState = z.infer<typeof RunState>

const Totals = z.strictObject({
	runs: z.number(),
	scenarios: z.number(),
	steps: z.number(),
	screenshots: z.number(),
	screenshotBytes: z.number(),
	tooBig: z.number(),
	missing: z.number(),
	notPng: z.number(),
})
type Totals = z.infer<typeof Totals>

const ImportState = z.strictObject({
	version: z.literal(1),
	/** The screenshot cutoff (ms) of the first run; `null` until one starts. A resume must use the same. */
	screenshotsSince: z.nullable(z.number()),
	projects: z.record(z.string(), z.strictObject({ to: z.string(), createdAt: z.boolean(), runsUncertain: z.boolean() })),
	runs: z.record(z.string(), RunState),
	totals: Totals,
})
export type ImportState = z.infer<typeof ImportState>

export interface StateStore {
	load(): ImportState
	save(state: ImportState): void
}

const emptyState = (): ImportState => ({
	version: 1,
	screenshotsSince: null,
	projects: {},
	runs: {},
	totals: { runs: 0, scenarios: 0, steps: 0, screenshots: 0, screenshotBytes: 0, tooBig: 0, missing: 0, notPng: 0 },
})

/** A JSON file written whole and renamed into place, so a crash never leaves half a state. */
export function fileState(path: string): StateStore {
	return {
		load: () => {
			let text: string
			try {
				text = readFileSync(path, 'utf8')
			} catch {
				return emptyState()
			}
			return ImportState.parse(JSON.parse(text))
		},
		save: (state) => {
			writeFileSync(`${path}.next`, JSON.stringify(state))
			renameSync(`${path}.next`, path)
		},
	}
}

export function memoryState(): StateStore & { readonly current: () => ImportState } {
	let saved = JSON.stringify(emptyState())
	return {
		load: () => ImportState.parse(JSON.parse(saved)),
		save: (state) => {
			saved = JSON.stringify(state)
		},
		current: () => ImportState.parse(JSON.parse(saved)),
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Transport: retry what certainly had no effect, stop on what may have.

/** The import stopped where a row may or may not be in already; the operator decides before it goes on. */
export class UncertainOutcome extends Error {
	override readonly name = 'UncertainOutcome'
}

/**
 * Whether a failed call may have taken effect: the connection dropped or timed out (the client answers status 0), a
 * gateway answered, or a 500, which a layer in front of the application may answer after its commit. A 4xx, a 429 and
 * a 503 (refused before any work) did not.
 */
export const mayHaveTakenEffect = (error: unknown) =>
	error instanceof RpcError
	&& (error.httpStatus === 0 || error.httpStatus === 500 || error.httpStatus === 502 || error.httpStatus === 504)

/** Procedures whose repetition changes nothing: they set values, they insert no row. */
const IDEMPOTENT = ['/migration.project', '/migration.screenshots']

/**
 * Retries a 429 or 503 (refused before any work), and, for an idempotent procedure, a dropped connection, a 500 or a
 * gateway answer too. What it gives up on reaches the client as its `RpcError`.
 */
export function retryingFetch(inner: RpcFetch, options: { backoffMs?: readonly number[]; timeoutMs?: number } = {}): RpcFetch {
	const backoff = options.backoffMs ?? [1000, 3000, 10000, 30000]
	const timeoutMs = options.timeoutMs ?? 120_000
	return async (input, init) => {
		const url = String(input instanceof Request ? input.url : input)
		const idempotent = IDEMPOTENT.some((suffix) => url.endsWith(suffix))
		for (let attempt = 0; ; attempt++) {
			const delay = backoff[attempt]
			let response: Response
			try {
				response = await inner(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })
			} catch (error) {
				if (idempotent && delay !== undefined) {
					await Bun.sleep(delay)
					continue
				}
				throw error
			}
			const refused = response.status === 429 || response.status === 503
			const unknown = response.status === 500 || response.status === 502 || response.status === 504
			if ((refused || (unknown && idempotent)) && delay !== undefined) {
				await Bun.sleep(delay)
				continue
			}
			return response
		}
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Rows → procedure inputs.

const nullable = (value: number | null) => value === null ? null : Math.round(value)

const runInput = (run: SourceRun) => ({
	from: run.id,
	branch: run.branch,
	commitSha: run.commit_sha,
	status: run.status,
	source: run.source,
	tier: run.tier,
	totalScenarios: run.total_scenarios,
	passedScenarios: run.passed_scenarios,
	failedScenarios: run.failed_scenarios,
	startedAt: Math.round(run.started_at),
	lastActivityAt: nullable(run.last_activity_at),
	reapedAt: nullable(run.reaped_at),
	finishedAt: nullable(run.finished_at),
})

const scenarioInput = (scenario: SourceScenario) => ({
	from: scenario.id,
	name: scenario.name,
	hash: scenario.hash,
	testFile: scenario.test_file,
	scenarioFile: scenario.scenario_file,
	feature: scenario.feature,
	seeds: scenario.seeds,
	roles: scenario.roles,
	tier: scenario.tier,
	status: scenario.status,
	durationMs: nullable(scenario.duration_ms),
	attempts: Math.max(1, scenario.attempts),
	startedAt: Math.round(scenario.started_at),
	finishedAt: nullable(scenario.finished_at),
	skippedAt: nullable(scenario.skipped_at),
	skipReason: scenario.skip_reason,
})

const stepInput = (step: SourceStep, scenarioId: string) => ({
	from: String(step.id),
	scenarioId,
	attempt: step.attempt,
	sequence: step.sequence,
	kind: step.kind,
	name: step.name,
	status: step.status,
	durationMs: Math.round(step.duration_ms),
	error: step.error,
	intent: step.intent,
	manual: step.manual,
	reason: step.reason,
	screenshotFailed: step.screenshot_failed !== 0,
	createdAt: Math.round(step.created_at),
})

/** Consecutive batches of at most {@link MAX_ROWS} items whose JSON stays under {@link MAX_BATCH_BYTES}. */
export function batches<T>(items: readonly T[]): T[][] {
	const out: T[][] = []
	let current: T[] = []
	let bytes = 0
	for (const item of items) {
		const size = JSON.stringify(item).length + 1
		if (current.length > 0 && (current.length >= MAX_ROWS || bytes + size > MAX_BATCH_BYTES)) {
			out.push(current)
			current = []
			bytes = 0
		}
		current.push(item)
		bytes += size
	}
	if (current.length > 0) out.push(current)
	return out
}

const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)

// ---------------------------------------------------------------------------------------------------------------
// The import.

/** The cutoff as `--screenshots-since` spells it. */
const cutoffLabel = (since: number) =>
	since === 0 ? 'all' : since === Number.MAX_SAFE_INTEGER ? 'none' : new Date(since).toISOString()

export interface ImportOptions {
	readonly source: Source
	readonly objects: ObjectSource
	readonly client: MigrationClient
	readonly state: StateStore
	/** Old project slug → the id of the project an operator created for it. */
	readonly projects: ReadonlyMap<string, string>
	/** Screenshots are copied for runs started at or after this time (ms); `Number.MAX_SAFE_INTEGER` copies none. */
	readonly screenshotsSince: number
	readonly concurrency: number
	/** Send again a batch whose earlier outcome was unknown (it may duplicate its rows). */
	readonly retryUncertain?: boolean
	readonly log?: (line: string) => void
}

export interface ImportSummary {
	readonly read: { readonly projects: number; readonly runs: number; readonly scenarios: number; readonly steps: number; readonly screenshotsInWindow: number }
	readonly totals: Totals
	readonly unmappedProjects: readonly string[]
	readonly uncertain: readonly string[]
	readonly runsDone: number
	readonly elapsedMs: number
}

export async function runImport(options: ImportOptions): Promise<ImportSummary> {
	const started = Date.now()
	const log = options.log ?? (() => {})
	const state = options.state.load()
	const save = () => options.state.save(state)
	// A moved cutoff would leave runs imported earlier without screenshots it now covers, or with some it no longer does.
	if (state.screenshotsSince !== null && state.screenshotsSince !== options.screenshotsSince) {
		throw new Error(
			`this state was started with --screenshots-since ${cutoffLabel(state.screenshotsSince)}, `
				+ `not ${cutoffLabel(options.screenshotsSince)}: pass the first value again, or start a new state file`,
		)
	}
	state.screenshotsSince = options.screenshotsSince
	save()
	const sourceProjects = options.source.projects()
	const mapped = sourceProjects.filter((project) => options.projects.has(project.slug))
	const unmappedProjects = sourceProjects.filter((project) => !options.projects.has(project.slug)).map((project) => project.slug)
	const counts = options.source.counts(mapped.map((project) => project.id), options.screenshotsSince)

	const queue: { run: SourceRun; projectSlug: string }[] = []
	for (const project of mapped) {
		const to = options.projects.get(project.slug) ?? ''
		const known = state.projects[project.slug]
		if (known !== undefined && known.to !== to) {
			throw new Error(`project ${project.slug} was imported into ${known.to}, not ${to}: use its state file or a new one`)
		}
		const entry = known ?? { to, createdAt: false, runsUncertain: false }
		state.projects[project.slug] = entry
		if (!entry.createdAt) {
			await options.client.project({ projectId: to, createdAt: Math.round(project.created_at) })
			entry.createdAt = true
			save()
		}
		const runs = options.source.runs(project.id)
		const pending = runs.filter((run) => state.runs[run.id] === undefined)
		if (pending.length > 0 && entry.runsUncertain && !options.retryUncertain) {
			throw new UncertainOutcome(`project ${project.slug}: a batch of runs may be in already; inspect, then rerun with --retry-uncertain`)
		}
		for (const batch of batches(pending.map(runInput))) {
			let ids: { from: string; to: string }[]
			try {
				ids = (await options.client.runs({ projectId: to, runs: batch })).ids
			} catch (error) {
				if (mayHaveTakenEffect(error)) {
					entry.runsUncertain = true
					save()
				}
				throw error
			}
			for (const pair of ids) {
				state.runs[pair.from] = {
					to: pair.to,
					scenariosAfter: null,
					scenarios: {},
					stepsAfter: null,
					steps: {},
					shotsAfter: null,
					done: false,
					uncertain: null,
				}
			}
			entry.runsUncertain = false
			state.totals.runs += ids.length
			save()
			log(`project ${project.slug}: ${ids.length} runs`)
		}
		for (const run of runs) queue.push({ run, projectSlug: project.slug })
	}

	const uncertain: string[] = []
	let failure: unknown = null
	const work = queue.filter(({ run }) => state.runs[run.id]?.done !== true)
	let next = 0
	const worker = async () => {
		while (failure === null) {
			const item = work[next++]
			if (item === undefined) return
			try {
				await importRun(item.run, state, save, options)
				log(`run ${item.run.id}: done`)
			} catch (error) {
				if (error instanceof UncertainOutcome || mayHaveTakenEffect(error)) {
					uncertain.push(item.run.id)
				}
				failure = failure ?? error
			}
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker))

	const summary: ImportSummary = {
		read: {
			projects: mapped.length,
			runs: counts.runs,
			scenarios: counts.scenarios,
			steps: counts.steps,
			screenshotsInWindow: counts.screenshotsInWindow,
		},
		totals: state.totals,
		unmappedProjects,
		uncertain: [...uncertain, ...Object.entries(state.runs).filter(([, run]) => run.uncertain !== null).map(([id]) => id)]
			.filter((id, index, all) => all.indexOf(id) === index),
		runsDone: Object.values(state.runs).filter((run) => run.done).length,
		elapsedMs: Date.now() - started,
	}
	if (failure !== null) {
		throw new ImportStopped(summary, failure)
	}
	return summary
}

/** The import stopped on an error; the summary says how far it got. */
export class ImportStopped extends Error {
	override readonly name = 'ImportStopped'
	constructor(readonly summary: ImportSummary, override readonly cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause))
	}
}

async function importRun(run: SourceRun, state: ImportState, save: () => void, options: ImportOptions): Promise<void> {
	const target = state.runs[run.id]
	if (target === undefined) return
	if (target.uncertain !== null && !options.retryUncertain) {
		throw new UncertainOutcome(`run ${run.id}: its ${target.uncertain} batch may be in already; inspect, then rerun with --retry-uncertain`)
	}
	// Records an unknown outcome on the run before it stops the import, so a rerun knows.
	const send = async <R>(phase: string, call: () => Promise<R>): Promise<R> => {
		try {
			const result = await call()
			target.uncertain = null
			return result
		} catch (error) {
			// A screenshot batch only sets values: sending it again is harmless, so it never blocks a rerun.
			if (mayHaveTakenEffect(error) && phase !== 'screenshots') {
				target.uncertain = phase
				save()
			}
			throw error
		}
	}

	const scenarios = options.source.scenarios(run.id, target.scenariosAfter)
	for (const batch of batches(scenarios.map(scenarioInput))) {
		const { ids } = await send('scenarios', () => options.client.scenarios({ runId: target.to, scenarios: batch }))
		for (const pair of ids) target.scenarios[pair.from] = pair.to
		target.scenariosAfter = batch[batch.length - 1]?.from ?? target.scenariosAfter
		state.totals.scenarios += ids.length
		save()
	}

	const copyShots = run.started_at >= options.screenshotsSince
	const steps = options.source.steps(run.id, target.stepsAfter)
	const inputs = steps.map((step) => {
		const scenarioId = target.scenarios[step.scenario_id]
		if (scenarioId === undefined) {
			throw new Error(`step ${step.id} of run ${run.id} names scenario ${step.scenario_id}, which was not imported`)
		}
		return stepInput(step, scenarioId)
	})
	const withShot = new Set(copyShots ? steps.filter((step) => step.screenshot_r2_key !== null).map((step) => String(step.id)) : [])
	for (const batch of batches(inputs)) {
		const { ids } = await send('steps', () => options.client.steps({ runId: target.to, steps: batch }))
		for (const pair of ids) {
			if (withShot.has(pair.from)) target.steps[pair.from] = pair.to
		}
		const last = batch[batch.length - 1]
		target.stepsAfter = last === undefined ? target.stepsAfter : Number(last.from)
		state.totals.steps += ids.length
		save()
	}

	if (copyShots) {
		await copyScreenshots(run, target, state, save, options, send)
	}
	target.done = true
	target.scenarios = {}
	target.steps = {}
	save()
}

async function copyScreenshots(
	run: SourceRun,
	target: RunState,
	state: ImportState,
	save: () => void,
	options: ImportOptions,
	send: <R>(phase: string, call: () => Promise<R>) => Promise<R>,
): Promise<void> {
	const shots = options.source.steps(run.id, target.shotsAfter).filter((step) => step.screenshot_r2_key !== null)
	let stepIds: string[] = []
	let files: Blob[] = []
	let bytes = 0
	let lastSeen = target.shotsAfter
	const flush = async () => {
		if (stepIds.length > 0) {
			const sending = { runId: target.to, stepIds, files }
			await send('screenshots', () => options.client.screenshots(sending))
			state.totals.screenshots += stepIds.length
			state.totals.screenshotBytes += bytes
		}
		target.shotsAfter = lastSeen
		save()
		stepIds = []
		files = []
		bytes = 0
	}
	for (const step of shots) {
		const key = step.screenshot_r2_key
		const to = target.steps[String(step.id)]
		if (key === null || to === undefined) continue
		const object = await options.objects.get(key)
		if (object === null) {
			state.totals.missing++
		} else if (object.byteLength > MAX_SCREENSHOT_BYTES) {
			state.totals.tooBig++
		} else if (!isPng(object)) {
			state.totals.notPng++
		} else {
			if (stepIds.length >= MAX_FILES || bytes + object.byteLength > MAX_FILES_BYTES) {
				await flush()
			}
			stepIds.push(to)
			files.push(new Blob([object], { type: 'image/png' }))
			bytes += object.byteLength
		}
		lastSeen = step.id
	}
	await flush()
}

/** What an import would move, read from the source and the state only. */
export function dryRun(options: Pick<ImportOptions, 'source' | 'state' | 'projects' | 'screenshotsSince'>) {
	const state = options.state.load()
	const sourceProjects = options.source.projects()
	const mapped = sourceProjects.filter((project) => options.projects.has(project.slug))
	const counts = options.source.counts(mapped.map((project) => project.id), options.screenshotsSince)
	return {
		projects: mapped.map((project) => `${project.slug} → ${options.projects.get(project.slug) ?? ''}`),
		unmappedProjects: sourceProjects.filter((project) => !options.projects.has(project.slug)).map((project) => project.slug),
		read: counts,
		alreadyImported: state.totals,
		runsDone: Object.values(state.runs).filter((run) => run.done).length,
	}
}
