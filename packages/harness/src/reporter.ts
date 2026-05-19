/**
 * Reporter — streams scenario/step/screenshot events to the opice platform.
 *
 * Events are fire-and-forget but tracked in a pending queue; `flush()` awaits
 * them before the process exits (registered via `beforeExit`). When env vars
 * aren't configured, falls back to a no-op so harness behavior matches the
 * bindx prototype.
 */

import { promises as fs } from 'node:fs'

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

class HttpReporter implements Reporter {
	private runIdPromise: Promise<string> | null = null
	private readonly pending: Set<Promise<unknown>> = new Set()
	private exitHookRegistered = false

	constructor(private readonly config: ReporterConfig) {}

	private async ensureRun(): Promise<string> {
		if (!this.runIdPromise) {
			this.runIdPromise = this.startRun()
			if (!this.exitHookRegistered) {
				this.exitHookRegistered = true
				process.on('beforeExit', () => {
					void this.flush()
				})
			}
		}
		return this.runIdPromise
	}

	private async startRun(): Promise<string> {
		const response = await this.fetch('POST', '/api/v1/runs', {
			branch: this.config.branch,
			commit: this.config.commit,
		})
		return response['runId'] as string
	}

	async startScenario(input: ScenarioStart): Promise<string> {
		const runId = await this.ensureRun()
		const response = await this.fetch('POST', `/api/v1/runs/${runId}/scenarios`, {
			name: input.name,
			hash: input.hash,
		})
		return response['scenarioId'] as string
	}

	async recordStep(event: StepEvent): Promise<void> {
		const runId = await this.ensureRun()
		const screenshot = event.screenshotPath
			? await this.encodeScreenshot(event.screenshotPath)
			: undefined
		const promise = this.fetch('POST', `/api/v1/runs/${runId}/scenarios/${event.scenarioId}/steps`, {
			name: event.name,
			status: event.status,
			durationMs: event.durationMs,
			error: event.error,
			screenshot,
		})
		this.track(promise)
	}

	async finishScenario(input: ScenarioFinish): Promise<void> {
		const runId = await this.ensureRun()
		this.track(
			this.fetch('PATCH', `/api/v1/runs/${runId}/scenarios/${input.scenarioId}`, {
				status: input.status,
				durationMs: input.durationMs,
			}),
		)
	}

	async flush(): Promise<void> {
		await Promise.allSettled([...this.pending])
		if (this.runIdPromise) {
			try {
				const runId = await this.runIdPromise
				await this.fetch('POST', `/api/v1/runs/${runId}/finish`, {})
			} catch {
				// best-effort finalization
			}
		}
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
	const endpoint = env['OPICE_ENDPOINT']
	const projectId = env['OPICE_PROJECT']
	const apiKey = env['OPICE_API_KEY']
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
