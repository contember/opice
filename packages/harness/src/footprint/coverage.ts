/**
 * V8 JS coverage → source files.
 *
 * The network layer already tells us which modules a dev server *served*
 * ({@link ../modules.ts}); coverage tells us which bytes actually *ran*, and is
 * the only thing that works at all against a production bundle. It costs real
 * time (V8 keeps per-function counters for the whole scenario) and needs source
 * maps to say anything useful about a bundle, so it only runs in `full` mode.
 *
 * Everything here is best-effort to the point of paranoia: a page that closed
 * mid-collection, a source map that 404s, a bundle with no map at all — each
 * degrades to fewer files plus a warning, never to a thrown error. A footprint
 * is telemetry; it must not be able to fail a test.
 */

import { existsSync } from 'node:fs'
import type { BrowserContext, Page } from 'playwright'
import { isIgnored, type FootprintConfig } from './config.js'
import { moduleUrlToSourcePath, normalizeSourceMapPath } from './modules.js'
import {
	decodeInlineSourceMap,
	decodeMappings,
	isIndexSourceMap,
	executedBytesBySource,
	flattenRanges,
	lineStartOffsets,
	parseSourceMap,
	readSourceMappingUrl,
	totalBytesBySource,
	type CoverageRange,
	type RawSourceMap,
} from './sourcemap.js'
import type { FootprintFile } from './types.js'

/** Cap on fetching a single source map, so a slow/huge map can't stall teardown. */
const SOURCE_MAP_TIMEOUT_MS = 5_000
/** Don't parse absurd maps — a multi-hundred-MB map is a pathology, not a build. */
const MAX_SOURCE_MAP_BYTES = 64 * 1024 * 1024
/** How many source maps are fetched at once — see {@link prefetchSourceMaps}. */
const SOURCE_MAP_CONCURRENCY = 4
/**
 * Total wall-clock budget for fetching source maps, across all of them.
 *
 * The per-map timeout bounds one request; it does not bound the queue. A page
 * referencing dozens of slow or unreachable maps would otherwise spend minutes
 * here — inside the scenario's own `afterAll` budget, failing a passing test over
 * telemetry that is documented as unable to do that. Whatever is fetched by the
 * deadline is used; the rest degrade to "no source map", which is a warning.
 */
const SOURCE_MAP_TOTAL_BUDGET_MS = 20_000

/**
 * Source maps skipped this run because they are index maps (`sections`), which
 * this decoder doesn't handle. Collected per collection pass and reported as a
 * warning — an unattributed bundle must not read as "touches no files".
 */
const indexMaps = new Set<string>()

/**
 * Start collecting. `resetOnNavigation: false` is the whole point — the default
 * would discard everything gathered before each navigation, which for a
 * walkthrough that moves between pages means discarding almost all of it.
 *
 * Returns false when the browser doesn't support coverage (it is Chromium-only),
 * so the caller can record that the collector didn't run rather than that it
 * found nothing.
 */
export async function startJsCoverage(page: Page): Promise<boolean> {
	try {
		await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: false })
		return true
	} catch {
		return false
	}
}

export interface CoverageResult {
	files: FootprintFile[]
	warnings: string[]
	/**
	 * Scripts whose sources could not be recovered — bundles with no usable source
	 * map. The caller needs this as a NUMBER, not as warning prose: it is what
	 * separates "this app has no file-level footprint" from "coverage read the
	 * bundle's source map and resolved it fine", and only the latter may replace
	 * the index's file edges.
	 */
	unmappedBundles: number
}

/**
 * Stop collecting and resolve the executed bytes back to source files.
 *
 * Must be called while the page is still open — it reads coverage off the page
 * and may fetch source maps through the context's request API.
 */
export async function collectJsCoverage(page: Page, context: BrowserContext, config: FootprintConfig): Promise<CoverageResult> {
	const warnings: string[] = []
	indexMaps.clear()
	let entries: Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>
	try {
		entries = await page.coverage.stopJSCoverage()
	} catch (err) {
		return { files: [], warnings: [`JS coverage could not be read: ${message(err)}`], unmappedBundles: 0 }
	}
	/** path → what we learned about it; the strongest claim wins if a file appears twice. */
	const byPath = new Map<string, { executed: number; exercised: boolean }>()
	let unmappedBundles = 0
	const mapCache = new Map<string, RawSourceMap | null>()
	// Fetch every external source map up front, concurrently. A production build
	// has 20-40 chunks, and resolving them inside the decode loop below would pay
	// that many sequential round trips (each with its own timeout) inside the
	// scenario's teardown budget.
	await prefetchSourceMaps(entries, context, mapCache)

	for (const entry of entries) {
		if (!entry.url) continue
		const ranges: CoverageRange[] = []
		for (const fn of entry.functions) {
			for (const range of fn.ranges) {
				ranges.push({ start: range.startOffset, end: range.endOffset, count: range.count })
			}
		}
		if (ranges.length === 0) continue
		const covered = flattenRanges(ranges).filter((r) => r.count > 0)
		if (covered.length === 0) continue
		// Bytes that ran INSIDE a named function, as opposed to a module's top
		// level. See {@link exercisedRanges} — this is what keeps "the app imported
		// this module" from reading the same as "this scenario used it".
		const exercised = flattenRanges(exercisedRanges(entry.functions)).filter((r) => r.count > 0)
		const source = entry.source
		const resolved = source ? await resolveSourceMap(entry.url, source, context, mapCache) : null
		const sourceMap = resolved?.map ?? null
		// Sources are resolved against the MAP's URL, per the source-map spec — a
		// map served from a different directory or origin than its script would
		// otherwise produce paths that match nothing in the repo.
		const mapBase = resolved?.url ?? entry.url

		if (sourceMap && source) {
			const lineStarts = lineStartOffsets(source)
			const mappings = decodeMappings(sourceMap.mappings, lineStarts)
			const executed = executedBytesBySource(mappings, covered)
			const exercisedBySource = executedBytesBySource(mappings, exercised)
			const totals = totalBytesBySource(mappings, source.length)
			for (const [index, bytes] of executed) {
				const raw = sourceMap.sources[index]
				if (raw === undefined) continue
				const path = resolveSourcePath(raw, sourceMap.sourceRoot, mapBase, config)
				if (!path || isIgnored(path, config.ignore)) continue
				const total = totals.get(index) ?? bytes
				record(byPath, path, total > 0 ? Math.min(1, bytes / total) : 1, (exercisedBySource.get(index) ?? 0) > 0)
			}
			continue
		}

		// No source map: the script's own URL is the best identity available. For a
		// dev server that IS the source file; for a hashed bundle it's meaningless,
		// which is what the warning below is for.
		const mapped = moduleUrlToSourcePath(entry.url, config.sourceRoot)
		if (mapped.bundled) {
			unmappedBundles++
			continue
		}
		if (!mapped.path || isIgnored(mapped.path, config.ignore)) continue
		const coveredBytes = covered.reduce((sum, r) => sum + (r.end - r.start), 0)
		const total = source?.length ?? 0
		record(byPath, mapped.path, total > 0 ? Math.min(1, coveredBytes / total) : 1, exercised.length > 0)
	}

	if (indexMaps.size > 0) {
		warnings.push(
			`${indexMaps.size} source map(s) are index maps (\`sections\`), which opice cannot decode — `
			+ 'the files behind those bundles are not in this footprint.',
		)
	}
	if (unmappedBundles > 0) {
		warnings.push(
			`${unmappedBundles} bundled script(s) had no source map — their source files are not in this footprint. `
			+ 'Run the app under a dev server, or build it with source maps, for file-level coverage.',
		)
	}
	// `exercised` is stated explicitly rather than left to be inferred: these are
	// the files V8 actually measured, so this is the one place that can tell
	// "loaded but never called" from "we couldn't measure it".
	const files: FootprintFile[] = [...byPath].map(([path, seen]) => ({
		path,
		source: 'coverage',
		executed: round(seen.executed),
		exercised: seen.exercised,
	}))
	files.sort((a, b) => a.path.localeCompare(b.path))
	return { files, warnings, unmappedBundles }
}

interface FileCoverage {
	executed: number
	exercised: boolean
}

function record(byPath: Map<string, FileCoverage>, path: string, executed: number, exercised: boolean): void {
	const previous = byPath.get(path)
	if (previous === undefined) {
		byPath.set(path, { executed, exercised })
		return
	}
	byPath.set(path, {
		executed: Math.max(previous.executed, executed),
		exercised: previous.exercised || exercised,
	})
}

/**
 * Ranges belonging to code the scenario *called*, as opposed to the module top
 * level, which merely ran because something imported the file.
 *
 * This distinction is what stops file-level footprint from saturating. Measured
 * on a real Contember admin: a single navigation scenario "executed" ~1300
 * source files at >50% of their bytes, because the admin evaluates its schema
 * and component library on load. Every scenario looked like it touched
 * everything, which would make impact selection useless — a change to any file
 * would select every test.
 *
 * What is excluded is the SCRIPT ROOT: V8 reports a script's top level as a
 * function with no name whose range starts at offset 0. Excluding every unnamed
 * function instead — which this used to do — overshoots, because V8 also leaves
 * the name empty for ordinary callbacks (`addEventListener('click', () => …)`,
 * an inline `onClick`). A file whose behaviour runs through those was reported
 * `exercised: false` and, since the default impact query matches exercised files
 * only, its scenario silently went unselected.
 *
 * Erring in this direction is deliberate. The two mistakes are not symmetric:
 * counting a file that was only loaded costs a few extra tests in CI, while
 * missing one the scenario really used means the change that breaks it does not
 * run it. `--impacted` is additive by design for exactly this reason.
 */
export function exercisedRanges(functions: readonly { functionName: string; ranges: readonly { startOffset: number; endOffset: number; count: number }[] }[]): CoverageRange[] {
	const ranges: CoverageRange[] = []
	for (const fn of functions) {
		if (isScriptRoot(fn)) continue
		for (const range of fn.ranges) {
			ranges.push({ start: range.startOffset, end: range.endOffset, count: range.count })
		}
	}
	return ranges
}

/**
 * The whole-script wrapper: unnamed AND starting at offset 0. A function's first
 * range is its own body, so the one that opens the script is the top level.
 * Anything nested — named or not — begins later.
 */
function isScriptRoot(fn: { functionName: string; ranges: readonly { startOffset: number }[] }): boolean {
	return !fn.functionName && fn.ranges[0]?.startOffset === 0
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000
}

/** A source map's `sourceRoot` prefixes each entry in `sources`. */
function joinSourceRoot(sourceRoot: string | undefined, source: string): string {
	if (!sourceRoot) return source
	if (source.startsWith('/') || /^[a-z-]+:\/\//i.test(source)) return source
	return sourceRoot.endsWith('/') ? `${sourceRoot}${source}` : `${sourceRoot}/${source}`
}

/**
 * Resolve one `sources` entry to a repo path.
 *
 * A relative source is resolved **against the script's URL**, which is what the
 * source-map spec says and what the observed data demands: a Vite dev module
 * carries an inline map whose only source is the bare file name
 * (`EmptyState.tsx`). Taken literally that produces a second, path-less entry
 * for a file the module collector already recorded as
 * `src/components/EmptyState.tsx` — the same file counted twice, under two
 * names, neither of which a `git diff` would match reliably. Resolving against
 * the script URL collapses them back into one.
 *
 * Bundler pseudo-schemes (`webpack://`) and absolute paths don't go through the
 * URL step; those are handled by {@link normalizeSourceMapPath}.
 */
export function resolveSourcePath(
	raw: string,
	sourceRoot: string | undefined,
	scriptUrl: string,
	config: FootprintConfig,
): string | null {
	const withRoot = joinSourceRoot(sourceRoot, raw)
	// A leading `/` is URL-rooted when the base is a URL (`sourceRoot: "/"` is
	// common), NOT a host filesystem path — reading it as one produced
	// `/src/App.tsx`, which matches nothing in a repo. Only skip URL resolution
	// for a path that actually exists on this machine.
	const rooted = withRoot.startsWith('/')
	const isLocalPath = rooted && existsSync(withRoot)
	if (!/^[a-z-]+:\/\//i.test(withRoot) && !isLocalPath) {
		try {
			const absolute = new URL(withRoot, scriptUrl)
			const mapped = moduleUrlToSourcePath(absolute.href, config.sourceRoot)
			// `bundled` here means the map pointed at another built artifact rather
			// than a source — fall through and let the textual normalizer decide.
			if (mapped.path) return mapped.path
			if (mapped.bundled) return null
		} catch {
			// Not resolvable as a URL — fall through to textual normalization.
		}
	}
	return normalizeSourceMapPath(withRoot, config.sourceRoot)
}

/**
 * Warm {@link mapCache} with every external source map the coverage entries
 * reference, fetched concurrently. Failures are cached as null by the fetch
 * itself, so the decode loop that follows never blocks on the network.
 */
async function prefetchSourceMaps(
	entries: readonly { url: string; source?: string }[],
	context: BrowserContext,
	cache: Map<string, RawSourceMap | null>,
): Promise<void> {
	const urls = new Set<string>()
	for (const entry of entries) {
		if (!entry.source || !entry.url) continue
		const reference = readSourceMappingUrl(entry.source)
		if (!reference || reference.startsWith('data:')) continue
		try {
			urls.add(new URL(reference, entry.url).href)
		} catch {
			// Unresolvable reference — the decode loop will simply find no map.
		}
	}
	// Bounded concurrency: a production build can reference dozens of maps, each
	// several MB, and fetching them all at once buffers all of them at once — in
	// the test process, during teardown, for a feature that must never be able to
	// fail a run.
	const pending = [...urls]
	const deadline = Date.now() + SOURCE_MAP_TOTAL_BUDGET_MS
	const skipped: string[] = []
	const workers = Array.from({ length: Math.min(SOURCE_MAP_CONCURRENCY, pending.length) }, async () => {
		for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
			// Stop SCHEDULING once the budget is spent — the request in flight still
			// has its own timeout, so the worst case stays bounded.
			if (Date.now() >= deadline) {
				skipped.push(url)
				continue
			}
			await fetchSourceMap(url, context, cache)
		}
	})
	await Promise.all(workers)
	// Record the skipped ones as misses. Without this the decode loop below finds
	// them absent from the cache and fetches every one again, one at a time — so
	// the budget would bound nothing at all.
	for (const url of skipped) if (!cache.has(url)) cache.set(url, null)
	if (skipped.length > 0) {
		console.warn(`[opice] source-map fetching hit its ${SOURCE_MAP_TOTAL_BUDGET_MS}ms budget — ${skipped.length} map(s) skipped.`)
	}
}

/**
 * Find a script's source map: inline `data:` URI first (what dev servers emit),
 * otherwise the `.map` alongside the script, which {@link prefetchSourceMaps}
 * has normally already cached.
 */
async function resolveSourceMap(
	scriptUrl: string,
	source: string,
	context: BrowserContext,
	cache: Map<string, RawSourceMap | null>,
): Promise<{ map: RawSourceMap; url: string } | null> {
	const reference = readSourceMappingUrl(source)
	if (!reference) return null
	if (reference.startsWith('data:')) {
		// An inline map travels with the script, so the script IS its base.
		const map = decodeInlineSourceMap(reference)
		return map ? { map, url: scriptUrl } : null
	}
	let absolute: string
	try {
		absolute = new URL(reference, scriptUrl).href
	} catch {
		return null
	}
	const map = await fetchSourceMap(absolute, context, cache)
	return map ? { map, url: absolute } : null
}

/** Fetch + parse one source map, memoized (including the failure) in `cache`. */
async function fetchSourceMap(
	url: string,
	context: BrowserContext,
	cache: Map<string, RawSourceMap | null>,
): Promise<RawSourceMap | null> {
	const cached = cache.get(url)
	if (cached !== undefined) return cached
	let map: RawSourceMap | null = null
	try {
		const response = await context.request.get(url, { timeout: SOURCE_MAP_TIMEOUT_MS, failOnStatusCode: false })
		if (response.ok()) {
			// Refuse from the DECLARED length first — checking after `body()` means
			// the oversize object has already been buffered, which is the thing the
			// cap exists to prevent.
			const declared = Number(response.headers()['content-length'] ?? '')
			if (Number.isFinite(declared) && declared > MAX_SOURCE_MAP_BYTES) {
				cache.set(url, null)
				return null
			}
			const body = await response.body()
			if (body.byteLength <= MAX_SOURCE_MAP_BYTES) {
				const text = body.toString('utf-8')
				map = parseSourceMap(text)
				if (!map && isIndexSourceMap(text)) indexMaps.add(url)
			}
		}
	} catch {
		// A map that can't be fetched is simply a bundle we can't attribute.
		map = null
	}
	cache.set(url, map)
	return map
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
