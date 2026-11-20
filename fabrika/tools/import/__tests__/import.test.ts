import { createClient, type RpcFetch } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contract } from '../../../fabrika.contract'
import app from '../../../src/app'
import { ImportStopped, machineClient, MAX_SCREENSHOT_BYTES, memoryState, type ObjectSource, retryingFetch, runImport } from '../core'
import { openSource } from '../source'

// A 1×1 transparent PNG.
const PNG = Uint8Array.from(
	atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
	(char) => char.charCodeAt(0),
)
const TOO_BIG = new Uint8Array(MAX_SCREENSHOT_BYTES + 1)
TOO_BIG.set(PNG.subarray(0, 8))

const DAY = 24 * 60 * 60 * 1000
const CUTOFF = Date.now() - 30 * DAY
const OLD = CUTOFF - 10 * DAY
const RECENT = CUTOFF + DAY

const database = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label: 'import.test.ts' })
const kit = testKit(app, { database: database.database, files: new MemoryFileObjects() })
const operatorApi = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor' }])) })
const importKey = kit.testCaller([{ action: 'data.import' }], { kind: 'machine' }).key ?? ''
const scratch = mkdtempSync(join(tmpdir(), 'opice-import-test-'))
afterAll(() => {
	database.close()
	rmSync(scratch, { recursive: true })
})

/** A database of the previous platform: its migrations 0001–0010 (prod never applied 0011), then rows. */
function sourceDatabase(name: string): string {
	const path = join(scratch, `${name}.sqlite`)
	const db = new Database(path, { create: true })
	const dir = new URL('../../../../packages/worker/migrations/', import.meta.url).pathname
	for (const file of readdirSync(dir).filter((file) => file.endsWith('.sql') && file < '0011').sort()) {
		db.exec(readFileSync(join(dir, file), 'utf8'))
	}
	const project = db.query('INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?) RETURNING id')
	const run = db.query(
		'INSERT INTO runs (id, project_id, branch, commit_sha, status, total_scenarios, passed_scenarios, failed_scenarios, started_at, finished_at, source, last_activity_at, tier) '
			+ 'VALUES (?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?, ?, ?)',
	)
	const scenario = db.query(
		'INSERT INTO scenarios (id, run_id, name, hash, status, duration_ms, started_at, finished_at, test_file, seeds, attempts, tier) '
			+ 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	const step = db.query(
		'INSERT INTO steps (scenario_id, sequence, kind, name, status, duration_ms, error, intent, screenshot_r2_key, created_at, attempt, manual, screenshot_failed) '
			+ 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
	)
	const alpha = projectId(project.get(name, `Project ${name}`, 1_600_000_000_000))
	projectId(project.get(`${name}-unmapped`, 'Not moved', 1_600_000_000_000))
	run.run(`${name}-old`, alpha, 'main', 'aaa', 'passed', OLD, OLD + 60_000, 'ci', OLD + 60_000, null)
	run.run(`${name}-recent`, alpha, 'feature', 'bbb', 'failed', RECENT, RECENT + 60_000, 'local', RECENT + 60_000, 'critical')
	for (const runId of [`${name}-old`, `${name}-recent`]) {
		const started = runId.endsWith('old') ? OLD : RECENT
		scenario.run(`${runId}-s1`, runId, 'signs in', 'h1', 'passed', 1234, started + 1000, started + 2000, 'tests/a.test.ts', '["user"]', 2, 'critical')
		scenario.run(`${runId}-s2`, runId, 'many steps', null, 'failed', 999.6, started + 3000, started + 4000, null, null, 1, null)
		const shots = [`${runId}/ok.png`, `${runId}/missing.png`, `${runId}/big.png`, `${runId}/text.png`]
		shots.forEach((key, index) => {
			step.run(`${runId}-s1`, index, 'step', `shot ${index}`, 'passed', 10.4, null, 'why', key, started + 1100 + index, 0, 'how', 0)
		})
		// Past one batch of 500, so a run's steps take two requests.
		for (let index = 0; index < 520; index++) {
			step.run(`${runId}-s2`, index, index === 519 ? 'invariant' : 'step', `step ${index}`, index === 519 ? 'failed' : 'passed', 5, index === 519 ? 'boom' : null, null, null, started + 3100 + index, 0, null, index === 3 ? 1 : 0)
		}
	}
	db.close()
	return path
}

function projectId(row: unknown): number {
	if (row !== null && typeof row === 'object' && 'id' in row && typeof row.id === 'number') return row.id
	throw new Error('no project id')
}

const objects = (prefix: string): ObjectSource & { readonly reads: string[] } => {
	const store = new Map<string, Uint8Array<ArrayBuffer>>()
	for (const runId of [`${prefix}-old`, `${prefix}-recent`]) {
		store.set(`${runId}/ok.png`, PNG)
		store.set(`${runId}/big.png`, TOO_BIG)
		store.set(`${runId}/text.png`, new TextEncoder().encode('not a png'))
	}
	const reads: string[] = []
	return {
		reads,
		get: async (key) => {
			reads.push(key)
			return store.get(key) ?? null
		},
	}
}

const client = (fetch: RpcFetch = kit.fetch) => machineClient({ key: importKey, fetch: retryingFetch(fetch, { backoffMs: [] }) }).migration

async function targetRows(slug: string) {
	const project = (await operatorApi.projects.get({ slug })).project
	if (project === null) throw new Error(`no project ${slug}`)
	const { runs } = await operatorApi.runs.listForProject({ projectId: project.id, limit: 100 })
	const all = []
	for (const run of runs) {
		const { scenarios } = await operatorApi.runs.scenarios({ runId: run.id })
		const steps = []
		for (const scenario of scenarios) {
			steps.push(...(await operatorApi.runs.steps({ runId: run.id, scenarioId: scenario.id })).steps)
		}
		all.push({ run, scenarios, steps })
	}
	return { project, runs: all }
}

describe('the import', () => {
	test('moves every row with its timestamps, and screenshots only of runs past the cutoff', async () => {
		const project = await operatorApi.projects.create({ slug: 'alpha', name: 'Project alpha' })
		const source = openSource(sourceDatabase('alpha'))
		const bucket = objects('alpha')
		const summary = await runImport({
			source,
			objects: bucket,
			client: client(),
			state: memoryState(),
			projects: new Map([['alpha', project.id]]),
			screenshotsSince: CUTOFF,
			concurrency: 2,
		})
		source.close()

		expect(summary.read).toEqual({ projects: 1, runs: 2, scenarios: 4, steps: 1048, screenshotsInWindow: 4 })
		expect(summary.unmappedProjects).toEqual(['alpha-unmapped'])
		expect(summary.totals).toEqual({
			runs: 2,
			scenarios: 4,
			steps: 1048,
			screenshots: 1,
			screenshotBytes: PNG.byteLength,
			tooBig: 1,
			missing: 1,
			notPng: 1,
		})
		// The old run's objects are never read.
		expect(bucket.reads.every((key) => key.startsWith('alpha-recent/'))).toBe(true)

		const target = await targetRows('alpha')
		expect(target.project.createdAt).toBe(1_600_000_000_000)
		const old = target.runs.find((entry) => entry.run.startedAt === OLD)
		const recent = target.runs.find((entry) => entry.run.startedAt === RECENT)
		expect(old?.run).toMatchObject({ branch: 'main', commitSha: 'aaa', source: 'ci', finishedAt: OLD + 60_000 })
		expect(recent?.run).toMatchObject({ branch: 'feature', tier: 'critical', source: 'local' })
		expect(old?.scenarios.find((scenario) => scenario.name === 'signs in')).toMatchObject({
			startedAt: OLD + 1000,
			finishedAt: OLD + 2000,
			seeds: ['user'],
			attempts: 2,
			durationMs: 1234,
		})
		expect(old?.steps.length).toBe(524)
		expect(old?.steps.find((step) => step.name === 'shot 0')).toMatchObject({ createdAt: OLD + 1100, intent: 'why', manual: 'how', screenshotUrl: null })
		expect(old?.steps.find((step) => step.name === 'step 3')?.screenshotFailed).toBe(true)
		expect(recent?.steps.filter((step) => step.screenshotUrl !== null).map((step) => step.name)).toEqual(['shot 0'])
	})

	test('continues after an interruption without inserting a row twice', async () => {
		const project = await operatorApi.projects.create({ slug: 'beta', name: 'Project beta' })
		const path = sourceDatabase('beta')
		const state = memoryState()
		let stepCalls = 0
		// The second batch of steps is refused before it reaches the application: the import stops there.
		const interrupted: RpcFetch = async (input, init) => {
			if (String(input).endsWith('/migration.steps') && ++stepCalls === 2) {
				return Response.json({ error: { type: 'bad_request', message: 'interrupted' } }, { status: 400 })
			}
			return kit.fetch(input, init)
		}
		const options = {
			objects: objects('beta'),
			state,
			projects: new Map([['beta', project.id]]),
			screenshotsSince: CUTOFF,
			concurrency: 1,
		}
		const first = openSource(path)
		const stopped = await runImport({ ...options, source: first, client: client(interrupted) }).catch((error: unknown) => error)
		first.close()
		expect(stopped).toBeInstanceOf(ImportStopped)
		expect(state.current().totals.steps).toBe(500)

		const second = openSource(path)
		const summary = await runImport({ ...options, source: second, client: client() })
		second.close()
		expect(summary.totals).toMatchObject({ runs: 2, scenarios: 4, steps: 1048, screenshots: 1 })
		const target = await targetRows('beta')
		expect(target.runs.length).toBe(2)
		expect(target.runs.flatMap((entry) => entry.steps).length).toBe(1048)
		expect(target.runs.flatMap((entry) => entry.scenarios).length).toBe(4)
	})

	test('stops on a request whose outcome is unknown, and sends it again only when told to', async () => {
		const project = await operatorApi.projects.create({ slug: 'gamma', name: 'Project gamma' })
		const path = sourceDatabase('gamma')
		const state = memoryState()
		let dropped = false
		// The connection drops before the first batch of scenarios reaches the application.
		const dropping: RpcFetch = async (input, init) => {
			if (String(input).endsWith('/migration.scenarios') && !dropped) {
				dropped = true
				throw new TypeError('connection reset')
			}
			return kit.fetch(input, init)
		}
		const options = {
			objects: objects('gamma'),
			state,
			projects: new Map([['gamma', project.id]]),
			screenshotsSince: CUTOFF,
			concurrency: 1,
		}
		const attempt = async (fetch: RpcFetch, retryUncertain: boolean) => {
			const source = openSource(path)
			try {
				return await runImport({ ...options, source, client: client(fetch), retryUncertain })
			} catch (error) {
				return error
			} finally {
				source.close()
			}
		}
		const first = await attempt(dropping, false)
		expect(first).toBeInstanceOf(ImportStopped)
		expect(first instanceof ImportStopped ? first.summary.uncertain.length : 0).toBe(1)
		expect(await attempt(kit.fetch, false)).toBeInstanceOf(ImportStopped)
		const done = await attempt(kit.fetch, true)
		expect(done).toMatchObject({ totals: { runs: 2, scenarios: 4, steps: 1048 }, uncertain: [] })
		const target = await targetRows('gamma')
		expect(target.runs.flatMap((entry) => entry.scenarios).length).toBe(4)
	})
})
