/**
 * Reporter — streams scenario/step/screenshot events to the opice platform.
 *
 * Steps are fire-and-forget (tracked in a pending queue so flush awaits
 * them). Scenario create + finish are awaited inline so the platform sees
 * the right status when the test process exits.
 *
 * The CLI handles end-of-run finalization: the reporter writes a
 * handoff file under $TMPDIR with the runId and credentials, the
 * `opice test` wrapper picks it up after `bun test` exits and POSTs
 * /api/v1/runs/<id>/finish so the dashboard sees the run as completed.
 *
 * When env vars aren't configured, the reporter falls back to a no-op so
 * harness behavior matches the bindx prototype.
 */

import { promises as fs } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseOpiceDsn } from './dsn.js'

export interface ReporterConfig {
	endpoint: string
	projectId: string
	apiKey: string
	branch?: string
	commit?: string
}

export interface StepEvent {
	scenarioId: string
	name: string
	status: 'passed' | 'failed'
	durationMs: number
	error?: string
	screenshotPath?: string
}

export interface ScenarioStart {
	name: string
	hash?: string
	testFile?: string
	scenarioFile?: string
}

export interface ScenarioFinish {
	scenarioId: string
	status: 'passed' | 'failed'
	durationMs: number
}

export interface Reporter {
	startScenario(input: ScenarioStart): Promise<string>
	recordStep(event: StepEvent): Promise<void>
	finishScenario(input: ScenarioFinish): Promise<void>
	flush(): Promise<void>
}

class NoopReporter implements Reporter {
	async startScenario(input: ScenarioStart): Promise<string> {
		return `noop-${input.name}-${Date.now()}`
	}
	async recordStep(_event: StepEvent): Promise<void> {}
	async finishScenario(_input: ScenarioFinish): Promise<void> {}
	async flush(): Promise<void> {}
}

export const HANDOFF_DIR = path.join(tmpdir(), 'opice-handoffs')

function handoffPath(pid = process.pid): string {
	return path.join(HANDOFF_DIR, `${pid}.json`)
}

export interface RunHandoff {
	endpoint: string
	apiKey: string
	runId: string
}

class HttpReporter implements Reporter {
	private runIdPromise: Promise<string> | null = null
	private readonly pending: Set<Promise<unknown>> = new Set()

	constructor(private readonly config: ReporterConfig) {}

	private async ensureRun(): Promise<string> {
		if (!this.runIdPromise) {
			this.runIdPromise = this.startRun()
		}
		return this.runIdPromise
	}

	private async startRun(): Promise<string> {
		const response = await this.fetch('POST', '/api/v1/runs', {
			branch: this.config.branch,
			commit: this.config.commit,
		})
		const runId = response['runId'] as string
		// Synchronous write so the CLI can pick this up even if the test
		// process exits abruptly (process.on('exit') runs sync).
		try {
			mkdirSync(HANDOFF_DIR, { recursive: true })
			const handoff: RunHandoff = { endpoint: this.config.endpoint, apiKey: this.config.apiKey, runId }
			writeFileSync(handoffPath(), JSON.stringify(handoff), 'utf-8')
		} catch {
			// best-effort
		}
		return runId
	}

	async startScenario(input: ScenarioStart): Promise<string> {
		const runId = await this.ensureRun()
		const response = await this.fetch('POST', `/api/v1/runs/${runId}/scenarios`, {
			name: input.name,
			hash: input.hash,
			testFile: input.testFile,
			scenarioFile: input.scenarioFile,
		})
		return response['scenarioId'] as string
	}

	recordStep(event: StepEvent): Promise<void> {
		// Track synchronously so flush() awaits the entire pipeline (including
		// encodeScreenshot's fs.readFile and the upload), not just whatever
		// fragment has run by the time afterAll fires.
		const promise = this.recordStepInternal(event)
		this.track(promise)
		return promise
	}

	private async recordStepInternal(event: StepEvent): Promise<void> {
		const runId = await this.ensureRun()
		const screenshot = event.screenshotPath
			? await this.encodeScreenshot(event.screenshotPath)
			: undefined
		await this.fetch('POST', `/api/v1/runs/${runId}/scenarios/${event.scenarioId}/steps`, {
			name: event.name,
			status: event.status,
			durationMs: event.durationMs,
			error: event.error,
			screenshot,
		})
	}

	async finishScenario(input: ScenarioFinish): Promise<void> {
		const runId = await this.ensureRun()
		// Awaited inline so the scenario status is committed before the
		// bun:test afterAll returns.
		await this.fetch('PATCH', `/api/v1/runs/${runId}/scenarios/${input.scenarioId}`, {
			status: input.status,
			durationMs: input.durationMs,
		})
	}

	async flush(): Promise<void> {
		await Promise.allSettled([...this.pending])
		// finishRun is the CLI's responsibility — see handoff file.
	}

	private track(promise: Promise<unknown>): void {
		this.pending.add(promise)
		promise.finally(() => this.pending.delete(promise))
	}

	private async encodeScreenshot(path: string): Promise<string | undefined> {
		try {
			const buf = await fs.readFile(path)
			return buf.toString('base64')
		} catch {
			return undefined
		}
	}

	private async fetch(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
		const response = await fetch(this.config.endpoint + path, {
			method,
			headers: {
				'authorization': `Bearer ${this.config.apiKey}`,
				'content-type': 'application/json',
			},
			body: body == null ? undefined : JSON.stringify(body),
		})
		if (!response.ok) {
			throw new Error(`opice reporter ${method} ${path} failed: ${response.status} ${await response.text()}`)
		}
		return (await response.json()) as Record<string, unknown>
	}
}

let active: Reporter = new NoopReporter()

export function getReporter(): Reporter {
	return active
}

export function setReporter(reporter: Reporter): void {
	active = reporter
}

export function configureFromEnv(env: NodeJS.ProcessEnv = process.env): Reporter {
	// Individual vars win; OPICE_DSN fills any gaps (see dsn.ts).
	const dsn = parseOpiceDsn(env['OPICE_DSN'])
	const endpoint = env['OPICE_ENDPOINT'] ?? dsn?.endpoint
	const projectId = env['OPICE_PROJECT'] ?? dsn?.project
	const apiKey = env['OPICE_API_KEY'] ?? dsn?.apiKey
	if (!endpoint || !projectId || !apiKey) {
		return new NoopReporter()
	}
	const reporter = new HttpReporter({
		endpoint,
		projectId,
		apiKey,
		branch: env['OPICE_BRANCH'] ?? env['GITHUB_REF_NAME'],
		commit: env['OPICE_COMMIT'] ?? env['GITHUB_SHA'],
	})
	setReporter(reporter)
	return reporter
}

// Auto-configure when imported.
configureFromEnv()
