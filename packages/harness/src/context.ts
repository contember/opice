import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { isTruthy } from './env.js'

/**
 * The live Playwright page for the running scenario.
 *
 * The browser process is launched **once** and reused across every scenario;
 * each `browserTest` only opens a fresh isolated `context` + `page` in
 * `beforeAll` and closes that context in `afterAll`. Launching (and tearing
 * down) a whole chromium per scenario is expensive — on a constrained CI runner
 * that per-scenario launch competes with the app/server for CPU and, when a
 * teardown stalls, leaks a zombie browser that drags the rest of the suite
 * down. A fresh context per scenario keeps the same isolation (separate
 * storage/cookies) at a fraction of the cost.
 *
 * The DSL — `el`, `byRole`, navigation — reads the current page from here. The
 * browser runs in-process under `bun test`; there is no shell-out and no daemon.
 */

let browser: Browser | null = null
let context: BrowserContext | null = null
let page: Page | null = null
// Filename stem for the current scenario's recording — set by `launchPage` and
// consumed by `closePage` when it saves the video. Null when video is off.
let currentVideoLabel: string | null = null

/** Headed mode for local debugging (`OPICE_HEADED=1` or Playwright's `PWDEBUG`). */
function headed(): boolean {
	return !!(process.env['OPICE_HEADED'] || process.env['PWDEBUG'])
}

interface VideoConfig {
	/** Where finished, nicely-named recordings are saved. */
	dir: string
	/** Recording (and viewport) size; defaults to Playwright's viewport. */
	size?: { width: number; height: number }
}

/**
 * Video recording config, or null when off. Opt-in via `OPICE_VIDEO` — recording
 * is overhead nobody wants on a normal CI run; it's for capturing tutorial
 * footage of a green walkthrough. `OPICE_VIDEO_DIR` sets the output folder
 * (default `opice-videos/`), `OPICE_VIDEO_SIZE` an optional `WxH` (e.g.
 * `1280x720`) used for both the recording and the viewport so the framing is
 * predictable.
 */
function videoConfig(): VideoConfig | null {
	if (!isTruthy(process.env['OPICE_VIDEO'])) return null
	const dir = process.env['OPICE_VIDEO_DIR'] || 'opice-videos'
	const size = parseSize(process.env['OPICE_VIDEO_SIZE'])
	return size ? { dir, size } : { dir }
}

/** Parse a `WIDTHxHEIGHT` string (e.g. `1280x720`); undefined if absent/invalid. */
function parseSize(raw: string | undefined): { width: number; height: number } | undefined {
	const m = raw?.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
	if (!m) return undefined
	const width = Number(m[1])
	const height = Number(m[2])
	return width > 0 && height > 0 ? { width, height } : undefined
}

/** Turn a scenario name into a safe, readable video filename stem. */
function slugify(name: string): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug || 'scenario'
}

// Video filename stems already saved this process. Two scenarios whose names
// slug to the same stem (e.g. "Login" and "Login!", or two emoji-only names that
// both fall back to "scenario") would otherwise overwrite each other's on-disk
// recording. We disambiguate the second and later with a `-2`, `-3`, … suffix so
// every scenario keeps its footage (the R2 key is already unique — it carries
// the scenario id — so this only protects the local OPICE_VIDEO_DIR files).
const usedVideoStems = new Set<string>()
function uniqueVideoStem(stem: string): string {
	let candidate = stem
	for (let n = 2; usedVideoStems.has(candidate); n++) {
		candidate = `${stem}-${n}`
	}
	usedVideoStems.add(candidate)
	return candidate
}

// Playwright writes recordings under `recordVideo.dir` with auto-generated hash
// names *as the context runs*; we point that at a scratch dir and `saveAs` the
// finished file under a scenario-named path, so the raw hashes never litter the
// user's output folder.
const VIDEO_RAW_DIR = path.join(tmpdir(), 'opice-videos-raw')

/** The active page, or throw if called outside a `browserTest` scenario. */
export function getPage(): Page {
	if (!page) {
		throw new Error('opice: no active page — call DSL helpers inside a browserTest scenario.')
	}
	return page
}

/** The active browser context (for cookies/storage, new tabs, etc.). */
export function getContext(): BrowserContext {
	if (!context) {
		throw new Error('opice: no active browser context — call inside a browserTest scenario.')
	}
	return context
}

/** Launch the shared browser once; reuse it on subsequent scenarios. */
async function getBrowser(): Promise<Browser> {
	if (!browser || !browser.isConnected()) {
		browser = await chromium.launch({ headless: !headed() })
	}
	return browser
}

/**
 * Open a fresh isolated context + page for a scenario, reusing the shared
 * browser. Called from `beforeAll`. Any context left over from a previous
 * scenario whose teardown didn't complete is closed first so state never
 * bleeds across scenarios.
 */
export async function launchPage(label?: string): Promise<Page> {
	if (context) {
		// A leftover context is a discarded attempt (a retry relaunches here): drop
		// its half-recorded video rather than saving it — only the final attempt,
		// closed via closePage, is worth keeping.
		const staleVideo = page?.video() ?? null
		await context.close().catch(() => {})
		await staleVideo?.delete().catch(() => {})
		context = null
		page = null
	}
	const b = await getBrowser()
	const video = videoConfig()
	context = await b.newContext(
		video
			? {
				recordVideo: { dir: VIDEO_RAW_DIR, ...(video.size ? { size: video.size } : {}) },
				...(video.size ? { viewport: video.size } : {}),
			}
			: {},
	)
	currentVideoLabel = video ? slugify(label ?? 'scenario') : null
	page = await context.newPage()
	return page
}

/**
 * Close the scenario's context (and page); keep the shared browser alive for
 * the next scenario. Called from `afterAll`. The browser itself is launched
 * once and reaped by Playwright's own process-exit handler when `bun test`
 * exits — see the `beforeExit` hook below for the graceful path.
 */
export async function closePage(): Promise<string | undefined> {
	// Grab the video handle before the page is torn down. Playwright finalizes the
	// file only once the context closes, so we save it afterwards.
	const video = page?.video() ?? null
	const label = currentVideoLabel
	try {
		await context?.close()
	} finally {
		page = null
		context = null
		currentVideoLabel = null
	}
	if (!video || !label) return undefined
	const cfg = videoConfig()
	const dir = cfg?.dir ?? 'opice-videos'
	const target = path.join(dir, `${uniqueVideoStem(label)}.webm`)
	try {
		await fs.mkdir(dir, { recursive: true })
		await video.saveAs(target)
		return target
	} catch (e) {
		console.warn(`[opice] failed to save video for "${label}" (ignored): ${e instanceof Error ? e.message : String(e)}`)
		return undefined
	} finally {
		// Drop the raw hash-named copy under the scratch dir.
		await video.delete().catch(() => {})
	}
}

// Graceful shutdown of the shared browser when the test process winds down. If
// this doesn't fire (hard exit/signal), Playwright's own exit handler still
// kills the chromium child, so the process never outlives the run.
process.once('beforeExit', () => {
	const b = browser
	browser = null
	void b?.close().catch(() => {})
})
