/**
 * Domain types shared between Db and the RPC router. Internal snake_case
 * row shapes stay private to db.ts; everything that crosses module
 * boundaries uses these camelCase DTOs.
 */

// Stored lifecycle status for runs and scenarios.
export type ScenarioStatus = 'running' | 'passed' | 'failed'
// On read, a scenario is shown as 'incomplete' when it carries a pending
// (unauthored) step, or 'warning' when it carries a tolerated fixme step — both
// computed, never stored. 'incomplete' outranks 'warning'.
export type ScenarioDisplayStatus = ScenarioStatus | 'warning' | 'incomplete'
// Runs add 'incomplete' — a computed display status (a run that never finished
// and was reaped, whose last activity went stale, or that contains a scenario
// with pending steps) — and 'warning'. Neither is stored; both are derived at
// read time.
export type RunStatus = ScenarioStatus | 'incomplete' | 'warning'
// 'fixme'/'fixmepass' are tolerated known-failure markers (see step.fixme):
// 'fixme' failed as expected, 'fixmepass' unexpectedly passed. 'pending' is a
// phase-1 skeleton stub that never ran (no body yet).
export type StepStatus = 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
// A step is a procedural step or a scenario-level acceptance ('invariant').
export type StepKind = 'step' | 'invariant'
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
	/** Subset of passed scenarios that carry a tolerated fixme step (and no pending step). */
	warningScenarios: number
	/** Subset of passed scenarios that carry a pending (unauthored) step. */
	incompleteScenarios: number
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
	/** Requirement / feature id this scenario covers (browserTest meta). */
	feature: string | null
	/** Seeds the scenario declared as preconditions (browserTest meta). */
	seeds: string[]
	/** Identities / roles the scenario acts as (browserTest meta). */
	roles: string[]
	status: ScenarioDisplayStatus
	durationMs: number | null
	/**
	 * How many attempts the scenario took (>= 1). A passed scenario with
	 * `attempts > 1` is flaky — it failed at least once before passing.
	 */
	attempts: number
	startedAt: number
	finishedAt: number | null
}

export interface Step {
	id: number
	scenarioId: string
	/** Which retry attempt (0-based) produced this step. */
	attempt: number
	sequence: number
	/** 'step' (procedural) or 'invariant' (scenario-level acceptance). */
	kind: StepKind
	name: string
	status: StepStatus
	durationMs: number
	error: string | null
	/** Durable rationale carried from the step's contract (phase-1 intent). */
	intent: string | null
	/** Mandatory note from step.fixme (why the failure is tolerated). */
	reason: string | null
	screenshotKey: string | null
	createdAt: number
}
