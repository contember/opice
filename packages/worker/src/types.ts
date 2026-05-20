/**
 * Domain types shared between Db and the RPC router. Internal snake_case
 * row shapes stay private to db.ts; everything that crosses module
 * boundaries uses these camelCase DTOs.
 */

export type RunStatus = 'running' | 'passed' | 'failed'
export type StepStatus = 'passed' | 'failed'

export interface Project {
	id: number
	slug: string
	name: string
	apiKeyHash: string
	readToken: string | null
	createdAt: number
}

export interface Run {
	id: string
	projectId: number
	branch: string | null
	commitSha: string | null
	status: RunStatus
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	startedAt: number
	finishedAt: number | null
}

export interface Scenario {
	id: string
	runId: string
	name: string
	hash: string | null
	testFile: string | null
	scenarioFile: string | null
	status: RunStatus
	durationMs: number | null
	startedAt: number
	finishedAt: number | null
}

export interface Step {
	id: number
	scenarioId: string
	sequence: number
	name: string
	status: StepStatus
	durationMs: number
	error: string | null
	screenshotKey: string | null
	createdAt: number
}
