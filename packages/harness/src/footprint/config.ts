/**
 * Footprint configuration — the env switch plus the repo's optional
 * `browser-footprint.ts` overrides.
 *
 * Collection is **opt-in**. Even the cheap half (network listeners) changes what
 * every run ships to the platform, so it stays behind a flag until it has proven
 * itself in practice rather than being switched on for everyone by default.
 *
 * The override file follows the same convention as `browser-tools.ts` /
 * `browser-auth.ts` / `browser-setup.ts`: a repo drops a `browser-footprint.ts`
 * at (or above) the test directory and exports a `footprint` object. It exists
 * because the two heuristics here — what a URL id looks like, and how a GraphQL
 * root field names an entity — are conventions, not laws. A repo that doesn't
 * follow them should be able to state the truth rather than live with a
 * plausible guess.
 */

import { pathToFileURL } from 'node:url'
import { isTruthy } from '../env.js'
import { findUserFile } from '../find-file.js'
import type { ParsedOperation } from './graphql.js'
import type { FootprintModel } from './types.js'

/**
 * How much to collect.
 *  - `off`     — nothing (default).
 *  - `network` — requests + GraphQL operations + dev-server module paths. Pure
 *                event listeners; no measurable overhead.
 *  - `full`    — the above plus V8 JS coverage and React component names, which
 *                cost real time and need source maps to be useful.
 */
export type FootprintMode = 'off' | 'network' | 'full'

export interface FootprintConfig {
	/**
	 * Origins that count as "the app" besides the scenario's own base URL — an
	 * API on a second port, a CDN serving the app's own modules. Requests to
	 * anything else are still recorded, but origin-qualified and never treated as
	 * source files.
	 */
	appOrigins?: string[]
	/**
	 * Paths to leave out of the file footprint. A string matches as a substring,
	 * a RegExp as a test. Vendor chunks and generated files are already excluded.
	 */
	ignore?: (string | RegExp)[]
	/**
	 * Prefix prepended to observed module paths, for when the dev server's root
	 * isn't the repo root (a monorepo app at `apps/web` serving `/src/App.tsx`
	 * that lives at `apps/web/src/App.tsx`). Matching is suffix-tolerant anyway,
	 * so this is a precision aid, not a requirement.
	 */
	sourceRoot?: string
	/** Replace the built-in URL → route templating. Return null to drop a request entirely. */
	normalizeUrl?: (url: string) => string | null
	/**
	 * Map a GraphQL operation to the models it touches, replacing the built-in
	 * verb+Entity heuristic. Return null to fall back to it.
	 */
	mapOperation?: (operation: ParsedOperation) => FootprintModel[] | null
	/** Root fields whose children are the real operations. Defaults to `['transaction']`. */
	transparentFields?: string[]
}

/** Resolve the collection mode from the environment. */
export function resolveMode(env: NodeJS.ProcessEnv = process.env): FootprintMode {
	const raw = (env['OPICE_FOOTPRINT'] ?? '').trim().toLowerCase()
	if (!raw) return 'off'
	if (raw === 'off' || raw === 'none' || raw === 'false' || raw === '0') return 'off'
	if (raw === 'network') return 'network'
	if (raw === 'full' || raw === 'all') return 'full'
	// `OPICE_FOOTPRINT=1` (the shape every other opice flag accepts) means "on";
	// `full` is what a bare `--footprint` sets, so treat a truthy value the same.
	if (isTruthy(raw)) return 'full'
	console.warn(`[opice] unknown OPICE_FOOTPRINT="${raw}" — footprint collection is off (use one of: off, network, full).`)
	return 'off'
}

/** Where local footprint JSON is written when there's no platform to ship it to. */
export function footprintDir(env: NodeJS.ProcessEnv = process.env): string {
	return env['OPICE_FOOTPRINT_DIR'] || '.opice/footprint'
}

/**
 * Locate a repo's `browser-footprint.ts` (or `.js`/`.mjs`), walking up from
 * `from` but never above the repository root (see {@link findUserFile} — this
 * file is imported and executed).
 */
export function findUserFootprintFile(from?: string): string | null {
	return findUserFile(['browser-footprint.ts', 'browser-footprint.js', 'browser-footprint.mjs'], from)
}

// Keyed by the resolved config FILE (or '' when there is none), because the
// lookup starts from the test's own directory: a monorepo run from the repo root
// legitimately resolves different configs for different packages, and one global
// slot would let whichever package ran first answer for all of them.
const cached = new Map<string, FootprintConfig>()

/**
 * Load the repo's footprint overrides, or an empty config when there are none.
 * Memoized: the file is imported once per process, and a broken one degrades to
 * the defaults with a warning — a footprint must never be able to fail a run.
 */
export async function loadFootprintConfig(from?: string): Promise<FootprintConfig> {
	const file = findUserFootprintFile(from)
	const key = file ?? ''
	const hit = cached.get(key)
	if (hit) return hit
	if (!file) {
		cached.set(key, {})
		return cached.get(key) as FootprintConfig
	}
	let config: FootprintConfig = {}
	try {
		const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
		const candidate = mod['footprint'] ?? mod['default']
		// Accept an object or a factory — a factory lets a repo read its own config
		// files before answering.
		const resolved = typeof candidate === 'function' ? (candidate as () => unknown)() : candidate
		if (typeof resolved === 'object' && resolved !== null) config = resolved as FootprintConfig
	} catch (err) {
		console.warn(`[opice] failed to load ${file} (ignored, using footprint defaults): ${err instanceof Error ? err.message : String(err)}`)
	}
	cached.set(key, config)
	return config
}

/** Does `path` match any ignore rule? */
export function isIgnored(path: string, ignore: FootprintConfig['ignore']): boolean {
	if (!ignore) return false
	return ignore.some((rule) => (typeof rule === 'string' ? path.includes(rule) : rule.test(path)))
}
