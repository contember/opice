// The shapes the dashboard, the share page and the reporter read, and the rows the raw reads parse. Times are integer
// milliseconds since the epoch.

import { z } from 'zod/v4'

export const RunStatus = z.enum(['running', 'passed', 'failed', 'incomplete', 'warning'])
export const ScenarioStatus = z.enum(['running', 'passed', 'failed', 'warning', 'incomplete', 'skipped'])
export const StoredStatus = z.enum(['running', 'passed', 'failed'])
export const StepStatus = z.enum(['passed', 'failed', 'fixme', 'fixmepass', 'pending'])
export const StepKind = z.enum(['step', 'invariant'])
export const RunSource = z.enum(['ci', 'local'])

export const Project = z.strictObject({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	createdAt: z.int(),
})

export const Run = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	branch: z.nullable(z.string()),
	commitSha: z.nullable(z.string()),
	status: RunStatus,
	source: z.nullable(RunSource),
	tier: z.nullable(z.string()),
	totalScenarios: z.int(),
	passedScenarios: z.int(),
	failedScenarios: z.int(),
	warningScenarios: z.int(),
	incompleteScenarios: z.int(),
	skippedScenarios: z.int(),
	startedAt: z.int(),
	finishedAt: z.nullable(z.int()),
})

export const RunWithProject = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	projectName: z.string(),
	branch: z.nullable(z.string()),
	commitSha: z.nullable(z.string()),
	status: RunStatus,
	source: z.nullable(RunSource),
	tier: z.nullable(z.string()),
	totalScenarios: z.int(),
	passedScenarios: z.int(),
	failedScenarios: z.int(),
	warningScenarios: z.int(),
	incompleteScenarios: z.int(),
	skippedScenarios: z.int(),
	startedAt: z.int(),
	finishedAt: z.nullable(z.int()),
})

export const ProjectWithLastRun = z.strictObject({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	createdAt: z.int(),
	lastRun: z.nullable(Run),
})

export const RunPage = z.strictObject({ runs: z.array(Run), hasMore: z.boolean() })
export const RunWithProjectPage = z.strictObject({ runs: z.array(RunWithProject), hasMore: z.boolean() })

export const Scenario = z.strictObject({
	id: z.string(),
	runId: z.string(),
	name: z.string(),
	hash: z.nullable(z.string()),
	testFile: z.nullable(z.string()),
	scenarioFile: z.nullable(z.string()),
	feature: z.nullable(z.string()),
	seeds: z.array(z.string()),
	roles: z.array(z.string()),
	tier: z.nullable(z.string()),
	skipReason: z.nullable(z.string()),
	status: ScenarioStatus,
	durationMs: z.nullable(z.int()),
	attempts: z.int(),
	startedAt: z.int(),
	finishedAt: z.nullable(z.int()),
	videoUrl: z.nullable(z.string()),
})

export const Step = z.strictObject({
	id: z.string(),
	scenarioId: z.string(),
	attempt: z.int(),
	sequence: z.int(),
	kind: StepKind,
	name: z.string(),
	status: StepStatus,
	durationMs: z.int(),
	error: z.nullable(z.string()),
	intent: z.nullable(z.string()),
	manual: z.nullable(z.string()),
	reason: z.nullable(z.string()),
	screenshotUrl: z.nullable(z.string()),
	screenshotFailed: z.boolean(),
	createdAt: z.int(),
})

export const Scenarios = z.strictObject({ scenarios: z.array(Scenario) })
export const Steps = z.strictObject({ steps: z.array(Step) })

export const ShareSummary = z.strictObject({
	id: z.string(),
	runId: z.string(),
	createdAt: z.int(),
	expiresAt: z.int(),
})

/** A dimension's values as the fabrika console offers them to an administrator who grants. */
export const DimensionValues = z.strictObject({
	values: z.array(z.strictObject({ value: z.string(), label: z.string().max(120).optional() })).max(500),
})

export const Ok = z.strictObject({ ok: z.literal(true) })

// Inputs several slices share.
export const ByRun = z.strictObject({ runId: z.string().min(1).max(100) })
export const ByRunScenario = z.strictObject({ runId: z.string().min(1).max(100), scenarioId: z.string().min(1).max(100) })
export const ByRunStep = z.strictObject({ runId: z.string().min(1).max(100), stepId: z.string().min(1).max(100) })

// The rows the raw reads answer, before the rules of `src/reports/logic.ts` derive the display status.
export const RunRow = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	branch: z.nullable(z.string()),
	commitSha: z.nullable(z.string()),
	status: StoredStatus,
	source: z.nullable(RunSource),
	tier: z.nullable(z.string()),
	startedAt: z.int(),
	lastActivityAt: z.nullable(z.int()),
	reapedAt: z.nullable(z.int()),
	finishedAt: z.nullable(z.int()),
})

export const RunWithProjectRow = z.strictObject({
	id: z.string(),
	projectId: z.string(),
	projectSlug: z.string(),
	projectName: z.string(),
	branch: z.nullable(z.string()),
	commitSha: z.nullable(z.string()),
	status: StoredStatus,
	source: z.nullable(RunSource),
	tier: z.nullable(z.string()),
	startedAt: z.int(),
	lastActivityAt: z.nullable(z.int()),
	reapedAt: z.nullable(z.int()),
	finishedAt: z.nullable(z.int()),
})

export const RunCountsRow = z.strictObject({
	runId: z.string(),
	total: z.int(),
	passed: z.int(),
	failed: z.int(),
	skipped: z.int(),
	warning: z.int(),
	incomplete: z.int(),
})

export const ScenarioFlagsRow = z.strictObject({
	scenarioId: z.string(),
	hasPending: z.int(),
	hasWarning: z.int(),
})

export const FinishCountsRow = z.strictObject({
	grand: z.int(),
	executed: z.int(),
	passed: z.int(),
	failed: z.int(),
})

export const NextSequenceRow = z.strictObject({ next: z.int() })
