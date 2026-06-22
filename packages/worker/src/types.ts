/**
 * Domain types shared between Db and the RPC router. Internal snake_case
 * row shapes stay private to db.ts; everything that crosses module
 * boundaries uses these camelCase DTOs.
 */

// Stored lifecycle status for runs and scenarios.
export type ScenarioStatus = 'running' | 'passed' | 'failed'
// On read, a scenario is shown as 'skipped' when the tier filter excluded it
// (backed by the skipped_at flag, never stored in `status`), 'incomplete' when
// it carries a pending (unauthored) step, or 'warning' when it carries a
// tolerated fixme step — all computed. 'skipped' wins (it never ran); otherwise
// 'incomplete' outranks 'warning'.
export type ScenarioDisplayStatus = ScenarioStatus | 'warning' | 'incomplete' | 'skipped'
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

export interface Project {
	id: number
	slug: string
	name: string
	createdAt: number
}

/** What a mirrored capability is for (see migration 0007). */
export type CapabilityKind = 'ingest' | 'read' | 'share'

/**
 * A local MIRROR row of a propustka credential opice issued (migration 0007; service-token
 * columns in 0009). The secret + authoritative validity live in propustka; this only records
 * metadata so the dashboard can list + revoke. The meaning of `id` depends on `kind`:
 *   - ingest → project write DSN — a SERVICE TOKEN (report.write on project:<slug>); `id` is the
 *              service PRINCIPAL id, `clientId` the non-secret Access client id
 *   - read   → project read DSN / agent read — a SERVICE TOKEN (report.read + project.read); same
 *   - share  → per-run read share link — a CAPABILITY token (report.read on run:<id> +
 *              project.read on project:<slug>); `id` is the capability token id, `clientId` NULL
 */
export interface CapabilityRecord {
	id: string
	projectId: number
	runId: string | null
	kind: CapabilityKind
	label: string | null
	/** Service-token Access client id (ingest/read); NULL for share capabilities. */
	clientId: string | null
	createdBy: string | null
	createdAt: number
	expiresAt: number | null
	revokedAt: number | null
}


export interface Run {
	id: string
	projectId: number
	branch: string | null
	commitSha: string | null
	status: RunStatus
	source: RunSource | null
	/** The tier this run selected (OPICE_TIER); null = no filter / ran everything. */
	tier: string | null
	/** Executed scenarios (passed + failed + running); excludes skipped. */
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	/** Subset of passed scenarios that carry a tolerated fixme step (and no pending step). */
	warningScenarios: number
	/** Subset of passed scenarios that carry a pending (unauthored) step. */
	incompleteScenarios: number
	/** Scenarios the tier filter excluded from this run (declared but not run). */
	skippedScenarios: number
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
	/** Declared tier (critical | standard | extended); null = legacy / standard. */
	tier: string | null
	/** Why the scenario was skipped (set only when status is 'skipped'). */
	skipReason: string | null
	/**
	 * R2 key of the scenario's walkthrough video (opt-in, OPICE_VIDEO), in the
	 * shared screenshots bucket under `<slug>/<runId>/...`. Null when video was off
	 * or the best-effort upload failed. The RPC layer maps this to a `videoUrl`.
	 */
	videoKey: string | null
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
	/**
	 * Human-readable manual line — the plain-language, stupid-simple instruction
	 * for a non-technical reader (target language, formal register). Stored, not
	 * yet displayed.
	 */
	manual: string | null
	/** Mandatory note from step.fixme (why the failure is tolerated). */
	reason: string | null
	screenshotKey: string | null
	/**
	 * True when a screenshot was captured but its upload to R2 failed (a transient
	 * R2 error, swallowed so it can't fail the run). Distinguishes "upload failed"
	 * from "no screenshot" — both leave screenshotKey null.
	 */
	screenshotFailed: boolean
	createdAt: number
}
