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

import type { BrowserContext, Page } from 'playwright'
import { isIgnored, type FootprintConfig } from './config.js'
import { moduleUrlToSourcePath, normalizeSourceMapPath } from './modules.js'
import {
	decodeInlineSourceMap,
	decodeMappings,
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
}

/**
 * Stop collecting and resolve the executed bytes back to source files.
 *
 * Must be called while the page is still open — it reads coverage off the page
 * and may fetch source maps through the context's request API.
 */
export async function collectJsCoverage(page: Page, context: BrowserContext, config: FootprintConfig): Promise<CoverageResult> {
	const warnings: string[] = []
	let entries: Awaited<ReturnType<Page['coverage']['stopJSCoverage']>>
	try {
		entries = await page.coverage.stopJSCoverage()
	} catch (err) {
		return { files: [], warnings: [`JS coverage could not be read: ${message(err)}`] }
	}
	/** path → executed ratio; the highest ratio seen wins if a file appears twice. */
	const byPath = new Map<string, number>()
	let unmappedBundles = 0
	const mapCache = new Map<string, RawSourceMap | null>()

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
		const source = entry.source
		const sourceMap = source ? await resolveSourceMap(entry.url, source, context, mapCache) : null

		if (sourceMap && source) {
			const lineStarts = lineStartOffsets(source)
			const mappings = decodeMappings(sourceMap.mappings, lineStarts)
			const executed = executedBytesBySource(mappings, covered)
			const totals = totalBytesBySource(mappings, source.length)
			for (const [index, bytes] of executed) {
				const raw = sourceMap.sources[index]
				if (raw === undefined) continue
				const resolved = normalizeSourceMapPath(joinSourceRoot(sourceMap.sourceRoot, raw), config.sourceRoot)
				if (!resolved || isIgnored(resolved, config.ignore)) continue
				const total = totals.get(index) ?? bytes
				record(byPath, resolved, total > 0 ? Math.min(1, bytes / total) : 1)
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
		record(byPath, mapped.path, total > 0 ? Math.min(1, coveredBytes / total) : 1)
	}

	if (unmappedBundles > 0) {
		warnings.push(
			`${unmappedBundles} bundled script(s) had no source map — their source files are not in this footprint. `
			+ 'Run the app under a dev server, or build it with source maps, for file-level coverage.',
		)
	}
	const files: FootprintFile[] = [...byPath].map(([path, executed]) => ({ path, source: 'coverage', executed: round(executed) }))
	files.sort((a, b) => a.path.localeCompare(b.path))
	return { files, warnings }
}

function record(byPath: Map<string, number>, path: string, executed: number): void {
	const previous = byPath.get(path)
	if (previous === undefined || executed > previous) byPath.set(path, executed)
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
 * Find a script's source map: inline `data:` URI first (what dev servers emit),
 * otherwise fetch the `.map` alongside the script. Results are cached per run —
 * a bundle's map is fetched once no matter how many entries reference it.
 */
async function resolveSourceMap(
	scriptUrl: string,
	source: string,
	context: BrowserContext,
	cache: Map<string, RawSourceMap | null>,
): Promise<RawSourceMap | null> {
	const reference = readSourceMappingUrl(source)
	if (!reference) return null
	if (reference.startsWith('data:')) return decodeInlineSourceMap(reference)
	let absolute: string
	try {
		absolute = new URL(reference, scriptUrl).href
	} catch {
		return null
	}
	const cached = cache.get(absolute)
	if (cached !== undefined) return cached
	let map: RawSourceMap | null = null
	try {
		const response = await context.request.get(absolute, { timeout: SOURCE_MAP_TIMEOUT_MS, failOnStatusCode: false })
		if (response.ok()) {
			const body = await response.body()
			map = body.byteLength > MAX_SOURCE_MAP_BYTES ? null : parseSourceMap(body.toString('utf-8'))
		}
	} catch {
		// A map that can't be fetched is simply a bundle we can't attribute.
		map = null
	}
	cache.set(absolute, map)
	return map
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}
