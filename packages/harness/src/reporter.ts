/**
 * Reporter — streams scenario/step/screenshot events to the opice platform.
 *
 * v0: no-op stub. The API shape is real, so tests using `step()`/`scenario()`
 * already work; the network calls are wired up in a later iteration.
 */

export interface ReporterConfig {
	endpoint: string
	projectId: string
	apiKey: string
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
	startRun(): Promise<string>
	startScenario(input: ScenarioStart): Promise<string>
	recordStep(event: StepEvent): Promise<void>
	finishScenario(input: ScenarioFinish): Promise<void>
	finishRun(): Promise<void>
}

class NoopReporter implements Reporter {
	async startRun(): Promise<string> {
		return `local-${Date.now()}`
	}
	async startScenario(input: ScenarioStart): Promise<string> {
		return `${input.name}-${Date.now()}`
	}
	async recordStep(_event: StepEvent): Promise<void> {
		// no-op
	}
	async finishScenario(_input: ScenarioFinish): Promise<void> {
		// no-op
	}
	async finishRun(): Promise<void> {
		// no-op
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
	// Real HTTP reporter wired in a later iteration.
	// For now, even with env present, fall back to noop so harness behavior
	// matches the bindx prototype until the platform exists.
	return new NoopReporter()
}
