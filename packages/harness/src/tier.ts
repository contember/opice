/**
 * Test tiers — an ordered hierarchy for *when* a scenario runs.
 *
 * A scenario declares its tier in `browserTest` meta (default `standard`); a run
 * selects a tier via `OPICE_TIER` (the `opice test --tier` flag). Selection is a
 * THRESHOLD: running a tier runs every scenario AT OR BELOW it — the standard
 * `smoke ⊂ regression ⊂ full` model. Scenarios above the selected tier are
 * *skipped*: still registered and reported as `skipped` (so the dashboard shows
 * the full inventory, not just what ran), but they never open a browser.
 *
 *   critical  — the must-pass core. Run on every push.
 *   standard  — the normal suite (the default for an untagged scenario). PRs / merges.
 *   extended  — slow / edge / expensive. Run nightly or on demand.
 *
 *   OPICE_TIER=critical → critical only
 *   OPICE_TIER=standard → critical + standard
 *   OPICE_TIER=extended → everything (also the default when OPICE_TIER is unset)
 */
export type Tier = 'critical' | 'standard' | 'extended'

/** Tiers low → high. A scenario's index is its level; it runs when level <= selected level. */
export const TIER_ORDER: readonly Tier[] = ['critical', 'standard', 'extended']

/** A scenario with no declared tier sits in the middle `standard` tier. */
export const DEFAULT_SCENARIO_TIER: Tier = 'standard'

/** With no `OPICE_TIER` set, run everything — select the widest tier. */
export const DEFAULT_SELECTED_TIER: Tier = 'extended'

function isTier(value: string | undefined): value is Tier {
	return value === 'critical' || value === 'standard' || value === 'extended'
}

/** Normalize a scenario's declared tier, defaulting (and tolerating junk) to `standard`. */
export function normalizeTier(tier: string | undefined): Tier {
	return isTier(tier) ? tier : DEFAULT_SCENARIO_TIER
}

export interface SelectedTier {
	tier: Tier
	/** false when `OPICE_TIER` held an unrecognized value (the caller may warn). */
	recognized: boolean
}

/**
 * The tier selected for this run, parsed from `OPICE_TIER`. Unset → run
 * everything. `all`/`full` are friendly aliases for the widest tier. An
 * unrecognized value resolves to "run everything" (`recognized: false`) rather
 * than silently dropping tests — better to over-run than to skip on a typo.
 */
export function parseSelectedTier(env: NodeJS.ProcessEnv = process.env): SelectedTier {
	const raw = env['OPICE_TIER']?.trim().toLowerCase()
	if (!raw) return { tier: DEFAULT_SELECTED_TIER, recognized: true }
	if (isTier(raw)) return { tier: raw, recognized: true }
	if (raw === 'all' || raw === 'full') return { tier: 'extended', recognized: true }
	return { tier: DEFAULT_SELECTED_TIER, recognized: false }
}

/** Convenience: the resolved selected tier, ignoring whether the value was recognized. */
export function resolveSelectedTier(env: NodeJS.ProcessEnv = process.env): Tier {
	return parseSelectedTier(env).tier
}

/** A scenario is skipped when its tier sits ABOVE the selected one. */
export function isTierSkipped(scenarioTier: Tier, selectedTier: Tier): boolean {
	return TIER_ORDER.indexOf(scenarioTier) > TIER_ORDER.indexOf(selectedTier)
}
