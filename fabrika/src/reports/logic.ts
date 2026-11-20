// The display rules of runs and scenarios. Only running, passed and failed are stored; incomplete, warning and skipped
// are derived when read, so a run nobody finished reads as incomplete even before the reaper marks it.

type Stored = 'running' | 'passed' | 'failed'
type RunDisplay = Stored | 'incomplete' | 'warning'
type ScenarioDisplay = Stored | 'warning' | 'incomplete' | 'skipped'

/** A run without ingest activity for this long is abandoned: the reaper finalizes it, and reads show it incomplete. */
export const STALE_RUN_MS = 10 * 60 * 1000

export interface RunTimes {
	readonly status: Stored
	readonly startedAt: number
	readonly lastActivityAt: number | null
	readonly reapedAt: number | null
	readonly finishedAt: number | null
}

export interface RunCounts {
	readonly total: number
	readonly passed: number
	readonly failed: number
	readonly skipped: number
	readonly warning: number
	readonly incomplete: number
}

export const NO_COUNTS: RunCounts = { total: 0, passed: 0, failed: 0, skipped: 0, warning: 0, incomplete: 0 }

/** A reaped run, or a running one idle past `STALE_RUN_MS`, is incomplete. */
export const isStale = (run: RunTimes, now: number): boolean =>
	run.reapedAt !== null
	|| (run.status === 'running' && run.finishedAt === null && now - (run.lastActivityAt ?? run.startedAt) > STALE_RUN_MS)

/** A passed run with a pending step reads incomplete, else with a tolerated fixme step warning; anything else wins. */
export const runDisplayStatus = (run: RunTimes, counts: RunCounts, now: number): RunDisplay => {
	if (isStale(run, now)) {
		return 'incomplete'
	}
	if (run.status !== 'passed') {
		return run.status
	}
	return counts.incomplete > 0 ? 'incomplete' : counts.warning > 0 ? 'warning' : 'passed'
}

/** A skipped scenario never ran; a passed one with a pending step is incomplete, with a fixme step a warning. */
export const scenarioDisplayStatus = (
	scenario: { readonly status: Stored; readonly skippedAt: number | null },
	flags: { readonly hasPending: boolean; readonly hasWarning: boolean },
): ScenarioDisplay => {
	if (scenario.skippedAt !== null) {
		return 'skipped'
	}
	if (scenario.status !== 'passed') {
		return scenario.status
	}
	return flags.hasPending ? 'incomplete' : flags.hasWarning ? 'warning' : 'passed'
}

/** A finished run fails on a hard failure, or when it reported nothing at all; only skipped scenarios still pass. */
export const finishedRunStatus = (counts: { readonly grand: number; readonly failed: number }): 'passed' | 'failed' =>
	counts.failed > 0 || counts.grand === 0 ? 'failed' : 'passed'

/** Older reporters send no attempt count; a scenario took at least one. */
export const attemptsOf = (attempts: number | undefined): number => attempts !== undefined && attempts >= 1 ? attempts : 1

/** Older reporters send no attempt; the first is 0. */
export const attemptOf = (attempt: number | undefined): number => attempt !== undefined && attempt >= 0 ? attempt : 0

/** Seeds and roles are stored as a JSON array of strings, or null when there are none. */
export const encodeList = (values: readonly string[] | undefined): string | null =>
	values !== undefined && values.length > 0 ? JSON.stringify(values) : null

export const decodeList = (stored: string | null): string[] => {
	if (stored === null) {
		return []
	}
	try {
		const parsed: unknown = JSON.parse(stored)
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
	} catch {
		return []
	}
}

