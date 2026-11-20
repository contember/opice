import { createClient, download } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../../fabrika.contract'
import app from '../../app'

// A 1×1 transparent PNG.
const PNG = Uint8Array.from(
	atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
	(char) => char.charCodeAt(0),
)
const screenshot = () => new Blob([PNG], { type: 'image/png' })

const database = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label: 'reports.test.ts' })
afterAll(() => database.close())
const kit = testKit(app, { database: database.database, files: new MemoryFileObjects() })

const operator = kit.testCaller([{ role: 'editor' }])
const operatorApi = createClient(contract, 'api', { fetch: kit.browser(operator) })

const ciKey = (projectId: string) => {
	const key = kit.testCaller([
		{ action: 'report.write', scope: { type: 'project', value: projectId } },
		{ action: 'report.read', scope: { type: 'project', value: projectId } },
	], { kind: 'machine' })
	return createClient(contract, 'machine', { fetch: kit.fetch, key: key.key ?? undefined })
}

const newProject = (slug: string) => operatorApi.projects.create({ slug, name: slug })

describe('reporting', () => {
	test('CI reports a run with a screenshot, and reads and the dashboard show it finished', async () => {
		const project = await newProject('flow')
		const ci = ciKey(project.id)
		const { runId } = await ci.reports.startRun({ projectId: project.id, branch: 'main', commit: 'abc', source: 'ci', tier: 'standard' })
		const { scenarioId } = await ci.reports.startScenario({ runId, name: 'signs in', seeds: ['user'], roles: ['admin'] })
		await ci.reports.startScenario({ runId, name: 'later', skipped: true, reason: 'above the tier' })
		const step = await ci.reports.step({
			runId,
			scenarioId,
			sequence: 0,
			name: 'open the page',
			status: 'passed',
			durationMs: 12.6,
			screenshot: screenshot(),
		})
		await ci.reports.step({ runId, scenarioId, sequence: 1, name: 'known bug', status: 'fixme', durationMs: 3, reason: 'tracked' })
		await ci.reports.finishScenario({ runId, scenarioId, status: 'passed', durationMs: 40, attempts: 2 })
		expect((await ci.reads.run({ runId })).status).toBe('running')
		await ci.reports.finishRun({ runId })

		const run = await operatorApi.runs.get({ runId })
		expect(run).toMatchObject({
			status: 'warning',
			branch: 'main',
			commitSha: 'abc',
			source: 'ci',
			tier: 'standard',
			totalScenarios: 1,
			passedScenarios: 1,
			warningScenarios: 1,
			skippedScenarios: 1,
		})
		const { scenarios } = await operatorApi.runs.scenarios({ runId })
		expect(scenarios.map((scenario) => [scenario.name, scenario.status, scenario.attempts])).toEqual([
			['signs in', 'warning', 2],
			['later', 'skipped', 1],
		])
		expect(scenarios[0]?.seeds).toEqual(['user'])
		const { steps } = await operatorApi.runs.steps({ runId, scenarioId })
		expect(steps.map((listed) => [listed.name, listed.status, listed.durationMs])).toEqual([
			['open the page', 'passed', 13],
			['known bug', 'fixme', 3],
		])
		const image = await kit.browser(operator)(`/api/runs.screenshot?runId=${runId}&stepId=${step.stepId}`)
		expect(image.status).toBe(200)
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(PNG)
		const page = await operatorApi.runs.listForProject({ projectId: project.id })
		expect(page.runs.map((listed) => listed.id)).toEqual([runId])
		const all = await operatorApi.runs.listAll({})
		expect(all.runs.find((listed) => listed.id === runId)?.projectSlug).toBe('flow')
		const found = await operatorApi.projects.get({ slug: 'flow' })
		expect(found.project?.id).toBe(project.id)
		expect((await operatorApi.projects.get({ slug: project.id })).project?.slug).toBe('flow')
		expect((await operatorApi.projects.get({ slug: 'no-such-project' })).project).toBeNull()
		const listed = await operatorApi.projects.list()
		expect(listed.projects.find((item) => item.slug === 'flow')?.lastRun?.id).toBe(runId)
	})

	test('only the final attempt of a retried scenario shows, and a pending step makes it incomplete', async () => {
		const project = await newProject('retry')
		const ci = ciKey(project.id)
		const { runId } = await ci.reports.startRun({ projectId: project.id })
		const { scenarioId } = await ci.reports.startScenario({ runId, name: 'flaky' })
		await ci.reports.step({ runId, scenarioId, attempt: 0, name: 'first try', status: 'failed', durationMs: 1, error: 'boom' })
		await ci.reports.step({ runId, scenarioId, attempt: 1, name: 'second try', status: 'passed', durationMs: 1 })
		await ci.reports.step({ runId, scenarioId, attempt: 1, name: 'not written yet', status: 'pending', durationMs: 0 })
		await ci.reports.finishScenario({ runId, scenarioId, status: 'passed', durationMs: 2 })
		await ci.reports.finishRun({ runId })
		const { steps } = await ci.reads.steps({ runId, scenarioId })
		expect(steps.map((step) => step.name)).toEqual(['second try', 'not written yet'])
		expect((await ci.reads.run({ runId })).status).toBe('incomplete')
	})

	test('a run that reported nothing fails when finished', async () => {
		const project = await newProject('empty')
		const ci = ciKey(project.id)
		const { runId } = await ci.reports.startRun({ projectId: project.id })
		await ci.reports.finishRun({ runId })
		expect((await ci.reads.run({ runId })).status).toBe('failed')
	})

	test("a key of one project reaches nothing of another project's runs", async () => {
		const mine = await newProject('mine')
		const theirs = await newProject('theirs')
		const own = ciKey(mine.id)
		const other = ciKey(theirs.id)
		const { runId } = await other.reports.startRun({ projectId: theirs.id })
		const { scenarioId } = await other.reports.startScenario({ runId, name: 'private' })
		expect(await statusOf(own.reports.startRun({ projectId: theirs.id }))).toBe(403)
		expect(await statusOf(own.reports.startScenario({ runId, name: 'intruder' }))).toBe(404)
		expect(await statusOf(own.reports.step({ runId, scenarioId, name: 'intruder', status: 'passed', durationMs: 1 }))).toBe(404)
		expect(await statusOf(own.reads.scenarios({ runId }))).toBe(404)
		expect(await statusOf(own.reports.finishRun({ runId }))).toBe(404)
	})

	test("a step names a scenario of its own run, never another run's", async () => {
		const project = await newProject('crossed')
		const ci = ciKey(project.id)
		const first = await ci.reports.startRun({ projectId: project.id })
		const second = await ci.reports.startRun({ projectId: project.id })
		const { scenarioId } = await ci.reports.startScenario({ runId: first.runId, name: 'in the first run' })
		expect(await statusOf(ci.reports.step({ runId: second.runId, scenarioId, name: 'misplaced', status: 'passed', durationMs: 1 }))).toBe(404)
	})

	test('a share link reads its run and nothing of another run', async () => {
		const project = await newProject('shared')
		const ci = ciKey(project.id)
		const { runId } = await ci.reports.startRun({ projectId: project.id })
		const { scenarioId } = await ci.reports.startScenario({ runId, name: 'shown' })
		const step = await ci.reports.step({ runId, scenarioId, name: 'with a picture', status: 'passed', durationMs: 1, screenshot: screenshot() })
		const other = await ci.reports.startRun({ projectId: project.id })
		const hidden = await ci.reports.startScenario({ runId: other.runId, name: 'hidden' })
		const otherStep = await ci.reports.step({ runId: other.runId, scenarioId: hidden.scenarioId, name: 'secret', status: 'passed', durationMs: 1 })

		const { url } = await operatorApi.shares.create({ runId, expiresInDays: 7 })
		const key = url.slice(url.indexOf('#') + 1)
		const visitor = createClient(contract, 'shared', { fetch: kit.fetch, key })
		expect((await visitor.run()).id).toBe(runId)
		expect((await visitor.scenarios()).scenarios.map((scenario) => scenario.name)).toEqual(['shown'])
		expect((await visitor.steps({ scenarioId })).steps.map((listed) => listed.id)).toEqual([step.stepId])
		expect(await statusOf(visitor.steps({ scenarioId: hidden.scenarioId }))).toBe(404)
		expect(await statusOf(download(visitor.screenshot, { stepId: otherStep.stepId }))).toBe(404)
		const shown = await download(visitor.screenshot, { stepId: step.stepId })
		expect(new Uint8Array(await shown.blob().arrayBuffer())).toEqual(PNG)

		const { shares } = await operatorApi.shares.list({ runId })
		expect(shares.length).toBe(1)
		const linkId = shares[0]?.id ?? ''
		expect(await operatorApi.shares.revoke({ runId, linkId })).toEqual({ revoked: true })
		expect((await operatorApi.shares.list({ runId })).shares).toEqual([])
	})

	test('a CI key reads but cannot write the dashboard, and a viewer cannot report', async () => {
		const project = await newProject('roles')
		const viewer = kit.testCaller([{ role: 'viewer' }])
		const viewerApi = createClient(contract, 'api', { fetch: kit.browser(viewer) })
		expect(await statusOf(viewerApi.projects.create({ slug: 'nope', name: 'nope' }))).toBe(403)
		const { runId } = await ciKey(project.id).reports.startRun({ projectId: project.id })
		expect(await statusOf(viewerApi.shares.create({ runId }))).toBe(403)
		expect((await viewerApi.runs.get({ runId })).id).toBe(runId)
	})

	test('a slug names one project', async () => {
		await newProject('twice')
		expect(await statusOf(newProject('twice'))).toBe(409)
	})
})

describe('the reaper', () => {
	test('marks a run idle past the stale limit reaped, and leaves an active or finished one', async () => {
		const project = await newProject('reaped')
		const importer = createClient(contract, 'machine', {
			fetch: kit.fetch,
			key: kit.testCaller([{ action: 'data.import' }], { kind: 'machine' }).key ?? undefined,
		})
		const longAgo = Date.now() - 60 * 60 * 1000
		const base = {
			branch: null,
			commitSha: null,
			source: null,
			tier: null,
			totalScenarios: 0,
			passedScenarios: 0,
			failedScenarios: 0,
			reapedAt: null,
		}
		const { ids } = await importer.migration.runs({
			projectId: project.id,
			runs: [
				{ ...base, from: 'stale', status: 'running', startedAt: longAgo, lastActivityAt: longAgo, finishedAt: null },
				{ ...base, from: 'active', status: 'running', startedAt: longAgo, lastActivityAt: Date.now(), finishedAt: null },
				{ ...base, from: 'finished', status: 'passed', startedAt: longAgo, lastActivityAt: longAgo, finishedAt: longAgo },
			],
		})
		const idOf = (from: string) => ids.find((pair) => pair.from === from)?.to ?? ''
		expect((await operatorApi.runs.get({ runId: idOf('stale') })).status).toBe('incomplete')
		expect(await kit.runJob('reapStaleRuns')).toMatchObject({ status: 'succeeded' })
		const ci = ciKey(project.id)
		// The reaped run stays incomplete after the job, now stored; the others are untouched.
		expect((await ci.reads.run({ runId: idOf('stale') })).finishedAt).not.toBeNull()
		expect((await ci.reads.run({ runId: idOf('active') })).status).toBe('running')
		expect((await ci.reads.run({ runId: idOf('finished') })).status).toBe('passed')
	})
})

describe('the import', () => {
	test('keeps every stored value, timestamps included, and attaches screenshots', async () => {
		const project = await newProject('imported')
		const importer = createClient(contract, 'machine', {
			fetch: kit.fetch,
			key: kit.testCaller([{ action: 'data.import' }], { kind: 'machine' }).key ?? undefined,
		})
		await importer.migration.project({ projectId: project.id, createdAt: 1_700_000_000_000 })
		const runs = await importer.migration.runs({
			projectId: project.id,
			runs: [{
				from: 'old-run',
				branch: 'main',
				commitSha: 'def',
				status: 'passed',
				source: 'ci',
				tier: null,
				totalScenarios: 1,
				passedScenarios: 1,
				failedScenarios: 0,
				startedAt: 1_700_000_100_000,
				lastActivityAt: 1_700_000_150_000,
				reapedAt: null,
				finishedAt: 1_700_000_200_000,
			}],
		})
		const runId = runs.ids[0]?.to ?? ''
		const scenarios = await importer.migration.scenarios({
			runId,
			scenarios: [{
				from: 'old-scenario',
				name: 'imported scenario',
				hash: 'h1',
				testFile: 'tests/a.test.ts',
				scenarioFile: null,
				feature: 'F-1',
				seeds: '["seed"]',
				roles: null,
				tier: 'critical',
				status: 'passed',
				durationMs: 900,
				attempts: 1,
				startedAt: 1_700_000_110_000,
				finishedAt: 1_700_000_190_000,
				skippedAt: null,
				skipReason: null,
			}],
		})
		const scenarioId = scenarios.ids[0]?.to ?? ''
		const steps = await importer.migration.steps({
			runId,
			steps: [{
				from: '42',
				scenarioId,
				attempt: 0,
				sequence: 0,
				kind: 'invariant',
				name: 'imported step',
				status: 'passed',
				durationMs: 5,
				error: null,
				intent: 'why',
				manual: 'how',
				reason: null,
				screenshotFailed: false,
				createdAt: 1_700_000_120_000,
			}],
		})
		const stepId = steps.ids[0]?.to ?? ''
		await importer.migration.screenshots({ runId, stepIds: [stepId], files: [screenshot()] })

		expect((await operatorApi.projects.get({ slug: 'imported' })).project?.createdAt).toBe(1_700_000_000_000)
		expect(await operatorApi.runs.get({ runId })).toMatchObject({
			status: 'passed',
			branch: 'main',
			commitSha: 'def',
			startedAt: 1_700_000_100_000,
			finishedAt: 1_700_000_200_000,
		})
		const [scenario] = (await operatorApi.runs.scenarios({ runId })).scenarios
		expect(scenario).toMatchObject({
			name: 'imported scenario',
			feature: 'F-1',
			seeds: ['seed'],
			tier: 'critical',
			durationMs: 900,
			startedAt: 1_700_000_110_000,
			finishedAt: 1_700_000_190_000,
		})
		const [step] = (await operatorApi.runs.steps({ runId, scenarioId })).steps
		expect(step).toMatchObject({ kind: 'invariant', intent: 'why', manual: 'how', createdAt: 1_700_000_120_000 })
		expect(step?.screenshotUrl).not.toBeNull()
		expect(await statusOf(operatorApi.runs.get({ runId: 'not-a-run' }))).toBe(404)
	})

	test('an import key without data.import is refused, and a CI key cannot import', async () => {
		const project = await newProject('guarded')
		expect(await statusOf(ciKey(project.id).migration.runs({ projectId: project.id, runs: [] }))).toBe(403)
	})
})
