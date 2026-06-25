/**
 * Explicit scenario selection — run a named set of scenarios IN ADDITION to the
 * tier, regardless of where they sit in the tier hierarchy.
 *
 * The tier (`OPICE_TIER`) answers *which band* runs; selection answers *also run
 * these specific scenarios, even if their tier sits above the selected band*.
 * The canonical use is CI on a pull request: run the always-on `critical` tier
 * PLUS exactly the scenarios the PR changed, so a touched `standard`/`extended`
 * scenario is exercised without dragging in the whole suite.
 *
 * Selection is a SET UNION with the tier, never a second pass: a scenario that
 * is both within the selected tier AND selected still registers — and runs —
 * exactly once. So a changed `critical` scenario is never run twice.
 *
 * `OPICE_SELECT` carries a comma-separated list of `*.test.ts` paths (the
 * `opice test --select` flag). Matching is path-shape tolerant — repo-relative
 * vs absolute, a leading `./`, OS separators, a trailing slash — and also
 * accepts a bare filename, so a `git diff --name-only` list drops straight in.
 */
import { isTierSkipped, type Tier } from './tier.js'

/** Parse the `OPICE_SELECT` env var into a list of select entries. */
export function parseSelectList(env: NodeJS.ProcessEnv = process.env): string[] {
	return splitSelect(env['OPICE_SELECT'])
}

/** Split a comma-separated select value into trimmed, non-empty entries. */
export function splitSelect(raw: string | undefined): string[] {
	if (!raw) return []
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean)
}

/**
 * Normalize a path for shape-tolerant comparison: drop a `file://` prefix,
 * `\` → `/`, strip any leading `./`, trim a trailing slash.
 */
export function normalizeSelectPath(p: string): string {
	let s = p.trim().replace(/^file:\/\//, '').replace(/\\/g, '/')
	while (s.startsWith('./')) s = s.slice(2)
	if (s.length > 1) s = s.replace(/\/+$/, '')
	return s
}

function basename(p: string): string {
	const i = p.lastIndexOf('/')
	return i === -1 ? p : p.slice(i + 1)
}

/**
 * Is `testFile` named by any entry in `selectList`? True when the normalized
 * paths are equal, when one is a path-suffix of the other (handles repo-relative
 * vs absolute), or when a bare-filename entry matches the file's basename.
 */
export function isScenarioSelected(testFile: string | undefined, selectList: string[]): boolean {
	if (!testFile || selectList.length === 0) return false
	const tf = normalizeSelectPath(testFile)
	if (!tf) return false
	const tfBase = basename(tf)
	return selectList.some((entry) => {
		const e = normalizeSelectPath(entry)
		if (!e) return false
		if (e === tf) return true
		if (tf.endsWith('/' + e)) return true
		if (e.endsWith('/' + tf)) return true
		// A bare filename (no slash) matches on basename alone.
		if (!e.includes('/') && e === tfBase) return true
		return false
	})
}

/** Why a scenario runs (or is skipped) this session. */
export type RunReason = 'tier' | 'selected' | 'skipped'

export interface ScenarioGate {
	run: boolean
	reason: RunReason
}

/**
 * The single source of truth for whether a scenario runs this session: it runs
 * when it sits WITHIN the selected tier OR when it was explicitly selected
 * (`--select` / OPICE_SELECT). This is a union, returned as ONE verdict per
 * scenario — a scenario that qualifies by tier reports `reason: 'tier'` even when
 * it also appears in the select list, so the caller registers (and runs) it
 * exactly once and never treats it as a second, "selected" entry. That is what
 * guarantees a changed `critical` scenario is not run twice.
 */
export function decideScenarioRun(
	scenarioTier: Tier,
	selectedTier: Tier,
	testFile: string | undefined,
	selectList: string[],
): ScenarioGate {
	if (!isTierSkipped(scenarioTier, selectedTier)) return { run: true, reason: 'tier' }
	if (isScenarioSelected(testFile, selectList)) return { run: true, reason: 'selected' }
	return { run: false, reason: 'skipped' }
}
