import { createClient, download } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test'
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

	test("finishing a scenario names a scenario of its own run, and another run's or project's is 404 and unchanged", async () => {
		const project = await newProject('finished-crossed')
		const ci = ciKey(project.id)
		const first = await ci.reports.startRun({ projectId: project.id })
		const second = await ci.reports.startRun({ projectId: project.id })
		const { scenarioId } = await ci.reports.startScenario({ runId: first.runId, name: 'in the first run' })
		expect(await statusOf(ci.reports.finishScenario({ runId: second.runId, scenarioId, status: 'failed', durationMs: 1 }))).toBe(404)

		const theirs = await newProject('finished-theirs')
		const other = ciKey(theirs.id)
		const foreign = await other.reports.startRun({ projectId: theirs.id })
		const hidden = await other.reports.startScenario({ runId: foreign.runId, name: 'theirs' })
		expect(await statusOf(ci.reports.finishScenario({ runId: first.runId, scenarioId: hidden.scenarioId, status: 'failed', durationMs: 1 }))).toBe(404)
		expect(await statusOf(ci.reports.finishScenario({ runId: foreign.runId, scenarioId: hidden.scenarioId, status: 'failed', durationMs: 1 }))).toBe(404)

		const statuses = async (reader: typeof ci, runId: string) => (await reader.reads.scenarios({ runId })).scenarios.map((listed) => listed.status)
		expect(await statuses(ci, first.runId)).toEqual(['running'])
		expect(await statuses(other, foreign.runId)).toEqual(['running'])
	})

	test("revoking names a share of its own run; another run's share is 404 and stays live", async () => {
		const project = await newProject('revoke-crossed')
		const ci = ciKey(project.id)
		const first = await ci.reports.startRun({ projectId: project.id })
		const second = await ci.reports.startRun({ projectId: project.id })
		const before = Date.now()
		await operatorApi.shares.create({ runId: second.runId, expiresInDays: 7 })
		const shared = (await operatorApi.shares.list({ runId: second.runId })).shares
		expect(shared.length).toBe(1)
		const shareId = shared[0]?.id ?? ''
		// Stored in milliseconds, about the seven days asked for.
		const expiresAt = shared[0]?.expiresAt ?? 0
		expect(expiresAt).toBeGreaterThan(before + 6 * 86_400_000)
		expect(expiresAt).toBeLessThan(before + 8 * 86_400_000)

		expect(await statusOf(operatorApi.shares.revoke({ runId: first.runId, shareId }))).toBe(404)
		expect((await operatorApi.shares.list({ runId: second.runId })).shares.map((share) => share.id)).toEqual([shareId])
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
		const shareId = shares[0]?.id ?? ''
		expect(await operatorApi.shares.revoke({ runId, shareId })).toEqual({ revoked: true })
		expect((await operatorApi.shares.list({ runId })).shares).toEqual([])
		// The link no longer reaches the run once the proxy's token for it expires; the kit's IAM refuses it at once.
		expect(await statusOf(visitor.run())).toBe(401)
		expect(await operatorApi.shares.revoke({ runId, shareId })).toEqual({ revoked: false })
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

	test('an unknown run is 404', async () => {
		expect(await statusOf(operatorApi.runs.get({ runId: 'not-a-run' }))).toBe(404)
	})

	test('a slug names one project', async () => {
		await newProject('twice')
		expect(await statusOf(newProject('twice'))).toBe(409)
	})

	test('the console offers the projects a reader reads, labelled name (slug), and none without project.read', async () => {
		const alpha = await operatorApi.projects.create({ slug: 'scope-alpha', name: 'Alpha' })
		const long = await operatorApi.projects.create({ slug: 'scope-long', name: 'L'.repeat(120) })
		const label = `${'L'.repeat(106)}… (scope-long)`
		const everyone = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'project.read' }])) })
		const offered = (await everyone.projects.scopeValues()).values.filter((entry) => [alpha.id, long.id].includes(entry.value))
		expect(offered).toEqual([{ value: alpha.id, label: 'Alpha (scope-alpha)' }, { value: long.id, label }])
		expect(label).toHaveLength(120)
		const one = createClient(contract, 'api', {
			fetch: kit.browser(kit.testCaller([{ action: 'project.read', scope: { type: 'project', value: alpha.id } }])),
		})
		expect(await one.projects.scopeValues()).toEqual({ values: [{ value: alpha.id, label: 'Alpha (scope-alpha)' }] })
		const reporter = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'report.read' }])) })
		expect(await statusOf(reporter.projects.scopeValues())).toBe(403)
	})
})

describe('the reaper', () => {
	test('marks a run idle past the stale limit reaped, and leaves an active or finished one', async () => {
		const project = await newProject('reaped')
		const ci = ciKey(project.id)
		const start = async () => (await ci.reports.startRun({ projectId: project.id })).runId
		const now = Date.now()
		const hourAgo = now - 60 * 60 * 1000
		try {
			// The handlers and the job stamp runs with the clock, so these runs are reported, and one reaped, in the past.
			setSystemTime(new Date(now - 2 * 60 * 60 * 1000))
			const reaped = await start()
			setSystemTime(new Date(hourAgo))
			expect(await kit.runJob('reapStaleRuns')).toMatchObject({ status: 'succeeded' })
			const stale = await start()
			const active = await start()
			const finished = await start()
			await ci.reports.finishRun({ runId: finished })
			setSystemTime()
			// Started an hour ago but reporting now: idleness counts from the last activity, not the start.
			await ci.reports.startScenario({ runId: active, name: 'still going' })

			expect((await operatorApi.runs.get({ runId: stale })).status).toBe('incomplete')
			expect(await kit.runJob('reapStaleRuns')).toMatchObject({ status: 'succeeded' })
			// The reaped run stays incomplete after the job, now stored; the others are untouched.
			expect((await ci.reads.run({ runId: stale })).finishedAt).not.toBeNull()
			expect((await ci.reads.run({ runId: active })).status).toBe('running')
			expect(await ci.reads.run({ runId: finished })).toMatchObject({ status: 'failed', finishedAt: hourAgo })
			// A run reaped before keeps the time it was reaped at.
			expect((await ci.reads.run({ runId: reaped })).finishedAt).toBe(hourAgo)
		} finally {
			setSystemTime()
		}
	})
})
