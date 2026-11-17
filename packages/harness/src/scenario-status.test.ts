import { afterAll, beforeAll, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

/**
 * The finish status a scenario reports must agree with bun's verdict on its
 * walkthrough. A timeout or a throw outside any step records no failed step, so
 * these drive real scenarios through `bun test` (real browser) and read the
 * statuses the file reporter wrote.
 */
// Same extension as this file, so the emitted dist copy runs the emitted fixture.
const fixture = path.join(import.meta.dir, 'fixtures', `walkthrough-status.fixture${path.extname(import.meta.path)}`)

const Finished = z.object({ name: z.string(), status: z.string().optional(), attempts: z.number().optional() })
type Finished = z.infer<typeof Finished>

let dir: string
let exitCode: number | null
let output: string
let finished: Finished[]

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(tmpdir(), 'scenario-status-test-'))
	const partsDir = path.join(dir, 'parts')
	const proc = Bun.spawn(['bun', 'test', fixture], {
		cwd: import.meta.dir,
		env: {
			// Drop inherited OPICE_* (a tier or selection would skip scenarios here).
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OPICE_'))),
			OPICE_REPORT_FILE: path.join(dir, 'report.html'),
			OPICE_REPORT_PARTS_DIR: partsDir,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
	exitCode = await proc.exited
	output = stdout + stderr
	finished = []
	for (const part of await fs.readdir(partsDir)) {
		if (!part.endsWith('.json')) continue
		const records = z.array(Finished).parse(JSON.parse(await fs.readFile(path.join(partsDir, part), 'utf-8')))
		finished.push(...records)
	}
}, 60_000)

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

function scenario(name: string): Finished | undefined {
	return finished.find(s => s.name === name)
}

test('bun fails the run the fixture breaks on purpose', () => {
	expect(exitCode, output).toBe(1)
})

test('a completed walkthrough finishes passed', () => {
	expect(scenario('passes')).toMatchObject({ status: 'passed', attempts: 1 })
})

test('a walkthrough killed by its timeout finishes failed', () => {
	expect(scenario('times out')).toMatchObject({ status: 'failed', attempts: 1 })
})

test('a throw outside any step finishes failed', () => {
	expect(scenario('throws outside a step')).toMatchObject({ status: 'failed', attempts: 1 })
})

test('a failed attempt followed by a passing retry finishes passed and flaky', () => {
	expect(scenario('throws, then passes on retry')).toMatchObject({ status: 'passed', attempts: 2 })
})
