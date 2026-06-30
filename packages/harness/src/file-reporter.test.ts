import { afterEach, beforeEach, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileReporter } from './file-reporter.js'
import type { ScenarioStart, StepEvent } from './reporter.js'

let dir: string
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(tmpdir(), 'file-reporter-test-'))
})
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

const scenario = (over: Partial<ScenarioStart> = {}): ScenarioStart => ({
	name: 'Example scenario',
	feature: 'F-1',
	roles: ['operator'],
	...over,
})

const stepEvent = (scenarioId: string, over: Partial<StepEvent> = {}): StepEvent => ({
	scenarioId,
	sequence: 0,
	name: 'a step',
	status: 'passed',
	durationMs: 12,
	...over,
})

const readReport = (file: string) => fs.readFile(file, 'utf-8')

test('renders a scenario, its steps, statuses and the summary', async () => {
	const report = path.join(dir, 'report.html')
	const r = new FileReporter(report)

	const id = await r.startScenario(scenario({ name: 'Org 360 detail' }))
	await r.recordStep(stepEvent(id, { sequence: 0, name: 'open detail', status: 'passed', intent: 'detail renders' }))
	await r.recordStep(stepEvent(id, { sequence: 1, name: 'broken step', status: 'failed', error: 'element not found: foo' }))
	await r.finishScenario({ scenarioId: id, status: 'failed', durationMs: 200, attempts: 1 })
	await r.flush()

	const html = await readReport(report)
	expect(html).toContain('Org 360 detail')
	expect(html).toContain('open detail')
	expect(html).toContain('detail renders') // intent surfaced
	expect(html).toContain('broken step')
	expect(html).toContain('element not found: foo') // error surfaced
	expect(html).toContain('F-1') // feature tag
	// Summary: 1 scenario, 0 passed (it failed), 2 steps.
	expect(html).toContain('>1 scenario<')
	expect(html).toContain('>2 steps<')
})

test('keeps only the final attempt’s steps when a flaky scenario retries', async () => {
	const report = path.join(dir, 'report.html')
	const r = new FileReporter(report)
	const id = await r.startScenario(scenario())

	// Attempt 0 — a step that will be discarded when attempt 1 starts.
	await r.recordStep(stepEvent(id, { attempt: 0, sequence: 0, name: 'attempt-0 step', status: 'failed' }))
	// Attempt 1 — the final, passing attempt.
	await r.recordStep(stepEvent(id, { attempt: 1, sequence: 0, name: 'attempt-1 step', status: 'passed' }))
	await r.finishScenario({ scenarioId: id, status: 'passed', durationMs: 50, attempts: 2 })
	await r.flush()

	const html = await readReport(report)
	expect(html).toContain('attempt-1 step')
	expect(html).not.toContain('attempt-0 step') // earlier attempt dropped
	expect(html).toContain('flaky · 2×') // flaky badge from attempts > 1
})

test('records a tier-skipped scenario as skipped', async () => {
	const report = path.join(dir, 'report.html')
	const r = new FileReporter(report)
	await r.skipScenario({ name: 'Above-tier scenario', reason: 'tier filter' })
	await r.flush()

	const html = await readReport(report)
	expect(html).toContain('Above-tier scenario')
	expect(html).toContain('skipped') // skipped status class
})

test('aggregates scenarios from sibling processes via partsDir', async () => {
	const report = path.join(dir, 'report.html')
	const partsDir = path.join(dir, 'parts')
	await fs.mkdir(partsDir, { recursive: true })

	// Simulate another process (a different test file) having already written its
	// part: a `<pid>.json` file holding one finished scenario. `partsDir` filenames
	// are pid-keyed, so this never collides with our own process's part.
	const otherScenario = {
		id: 'local-0-99999',
		name: 'Other-file scenario',
		feature: 'F-2',
		attempt: 0,
		steps: [{ sequence: 0, name: 'other step', status: 'passed', durationMs: 5 }],
		status: 'passed',
		durationMs: 5,
	}
	await fs.writeFile(path.join(partsDir, '99999.json'), JSON.stringify([otherScenario]), 'utf-8')

	// This process renders into the same report with the shared partsDir.
	const r = new FileReporter(report, partsDir)
	const id = await r.startScenario(scenario({ name: 'This-file scenario' }))
	await r.recordStep(stepEvent(id, { name: 'this step', status: 'passed' }))
	await r.finishScenario({ scenarioId: id, status: 'passed', durationMs: 30, attempts: 1 })
	await r.flush()

	const html = await readReport(report)
	// The union of both processes' scenarios is present — the last file didn't
	// clobber the first.
	expect(html).toContain('Other-file scenario')
	expect(html).toContain('This-file scenario')
	expect(html).toContain('>2 scenarios<')
})

test('escapes HTML in scenario/step text', async () => {
	const report = path.join(dir, 'report.html')
	const r = new FileReporter(report)
	const id = await r.startScenario(scenario({ name: '<script>alert(1)</script>' }))
	await r.recordStep(stepEvent(id, { name: 'a & b < c', status: 'passed' }))
	await r.finishScenario({ scenarioId: id, status: 'passed', durationMs: 10, attempts: 1 })
	await r.flush()

	const html = await readReport(report)
	expect(html).not.toContain('<script>alert(1)</script>')
	expect(html).toContain('&lt;script&gt;')
	expect(html).toContain('a &amp; b &lt; c')
})
