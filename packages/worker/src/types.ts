/**
 * Domain types shared between Db and the RPC router. Internal snake_case
 * row shapes stay private to db.ts; everything that crosses module
 * boundaries uses these camelCase DTOs.
 */

// Stored lifecycle status for runs and scenarios.
export type ScenarioStatus = 'running' | 'passed' | 'failed'
// On read, a passed scenario/run that contains a tolerated fixme step is shown
// as 'warning' (amber) — computed, never stored, like 'incomplete'.
export type ScenarioDisplayStatus = ScenarioStatus | 'warning'
// Runs add 'incomplete' — a computed display status (a run that never finished
// and was reaped, or whose last activity went stale) — and 'warning'. Neither
// is stored; both are derived at read time.
export type RunStatus = ScenarioStatus | 'incomplete' | 'warning'
// 'fixme'/'fixmepass' are tolerated known-failure markers (see step.fixme):
// 'fixme' failed as expected, 'fixmepass' unexpectedly passed.
export type StepStatus = 'passed' | 'failed' | 'fixme' | 'fixmepass'
export type RunSource = 'ci' | 'local'

/**
 * What a credential is allowed to do. `read` < `write` < `admin` in privilege,
 * but they are tracked as an explicit set per principal rather than a level, so
 * a CI key can be `write`-only without implying `read` of the dashboard.
 */
export type Capability = 'read' | 'write' | 'admin'

export interface Project {
	id: number
	slug: string
	name: string
	createdAt: number
}

/**
 * A machine / share credential (see migration 0003). The plaintext secret is
 * never stored — only `tokenHash`. `projectSlug` is denormalized in on read via
 * a join so the resolver can build a scope without a second query.
 */
export interface Token {
	id: string
	tokenHash: string
	capability: Capability
	projectId: number | null
	projectSlug: string | null
	runId: string | null
	label: string | null
	createdBy: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
	revokedAt: number | null
}

export interface Run {
	id: string
	projectId: number
	branch: string | null
	commitSha: string | null
	status: RunStatus
	source: RunSource | null
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	/** Subset of passed scenarios that carry a tolerated fixme step. */
	warningScenarios: number
	startedAt: number
	finishedAt: number | null
}

/** A run carrying its project's slug + name, for the cross-project feed. */
export interface RunWithProject extends Run {
	projectSlug: string
	projectName: string
}

export interface Scenario {
	id: string
	runId: string
	name: string
	hash: string | null
	testFile: string | null
	scenarioFile: string | null
	status: ScenarioDisplayStatus
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
	/** Mandatory note from step.fixme (why the failure is tolerated). */
	reason: string | null
	screenshotKey: string | null
	createdAt: number
}
