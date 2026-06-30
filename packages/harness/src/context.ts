import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { resolveStorageState } from './auth.js'
import { isTruthy } from './env.js'
import { slugify } from './slug.js'

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
// Human scenario name + step timeline for the recording's sidecar manifest
// (consumed by a post-production step — captions, zoom-to-cursor, chapters).
let currentVideoName: string | null = null
let videoStartMs = 0
interface VideoStep {
	name: string
	kind: string
	sequence: number
	/** Start offset from the first video frame, in ms. */
	tStartMs: number
	durationMs: number
	status: string
	/** Cursor position (viewport px) at the end of the step — the action's anchor. */
	cursor?: { x: number; y: number }
}
let videoSteps: VideoStep[] = []

/** The recording's sidecar manifest: enough for a post-production layer to add
 *  captions, chapters and zoom-to-action without re-driving the app. */
interface VideoManifest {
	scenario: string
	video: string
	size?: { width: number; height: number }
	steps: VideoStep[]
}

/** Headed mode for local debugging (`OPICE_HEADED=1` or Playwright's `PWDEBUG`). */
function headed(): boolean {
	return !!(process.env['OPICE_HEADED'] || process.env['PWDEBUG'])
}

interface VideoConfig {
	/** Where finished, nicely-named recordings are saved. */
	dir: string
	/** Recording (and viewport) size; defaults to Playwright's viewport. */
	size?: { width: number; height: number }
	/** Draw a synthetic cursor so clicks/moves are followable in the recording. */
	cursor: boolean
	/** Per-action delay (ms) so the cursor glides into place before each click. */
	slowMo: number
}

// Injected into every page when video + cursor are on. Playwright drives the
// real OS cursor, which isn't captured in the recording — so a viewer can't see
// where clicks land. This draws a dot that follows the (real, Playwright-driven)
// mouse events; the CSS transition + `slowMo` pacing make it glide to each
// target before the click fires. Pure DOM, no deps, removed automatically when
// video is off (it's only injected then).
const CURSOR_SCRIPT = `(() => {
  const STYLE = 'position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;'
    + 'background:rgba(0,90,224,0.22);border:2px solid #005ae0;box-shadow:0 2px 10px rgba(0,90,224,0.45);'
    + 'z-index:2147483647;pointer-events:none;transition:left .18s ease-out,top .18s ease-out,transform .1s ease-out';
  const ensure = () => {
    let c = document.getElementById('__opice_cursor');
    if (!c && document.body) { c = document.createElement('div'); c.id = '__opice_cursor'; c.setAttribute('style', STYLE); document.body.appendChild(c); }
    return c;
  };
  const at = (x, y) => { const c = ensure(); if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; } };
  document.addEventListener('mousemove', (e) => at(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', () => { const c = ensure(); if (c) c.style.transform = 'scale(0.65)'; }, true);
  document.addEventListener('mouseup', () => { const c = ensure(); if (c) c.style.transform = 'scale(1)'; }, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure); else ensure();
})()`

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
	// Cursor on by default (it's what makes a recording followable); opt out with
	// `OPICE_VIDEO_CURSOR=0`. `OPICE_VIDEO_SLOWMO` paces actions so the cursor
	// glides before each click (defaults to 120ms; 0 disables pacing).
	const cursorEnv = process.env['OPICE_VIDEO_CURSOR']
	const cursor = cursorEnv === undefined ? true : isTruthy(cursorEnv)
	const slowMo = parsePositiveInt(process.env['OPICE_VIDEO_SLOWMO']) ?? 120
	return { dir, cursor, slowMo, ...(size ? { size } : {}) }
}

// Warn once per run that a recorded run is NOT a faithful timing replica of a
// normal run: `slowMo` paces every action and a synthetic cursor is injected into
// the app, so a timing-sensitive walkthrough can pass while recording yet behave
// differently in a plain CI run. Recording is for tutorial footage, not for
// inferring pass/fail timing — say so loudly rather than letting the footage
// silently misrepresent the suite.
let warnedRecordingTiming = false
function warnRecordingTiming(): void {
	if (warnedRecordingTiming) return
	warnedRecordingTiming = true
	console.warn(
		'[opice] OPICE_VIDEO is on — the run is paced for recording (slowMo) and a synthetic cursor is '
		+ 'injected into the app under test. A recorded run does NOT have the same timing as a normal run; '
		+ 'use the footage for tutorials, not to infer timing-sensitive pass/fail behaviour.',
	)
}

/** Parse a non-negative integer; undefined if absent/invalid. */
function parsePositiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/** Parse a `WIDTHxHEIGHT` string (e.g. `1280x720`); undefined if absent/invalid. */
function parseSize(raw: string | undefined): { width: number; height: number } | undefined {
	const m = raw?.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i)
	if (!m) return undefined
	const width = Number(m[1])
	const height = Number(m[2])
	return width > 0 && height > 0 ? { width, height } : undefined
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
		// `slowMo` paces Playwright's actions so the synthetic cursor can glide to
		// each target before the click. It's per-run (OPICE_VIDEO is process-wide),
		// so applying it at launch on the shared browser is fine.
		const video = videoConfig()
		const slowMo = video && video.slowMo > 0 ? video.slowMo : undefined
		browser = await chromium.launch({ headless: !headed(), ...(slowMo ? { slowMo } : {}) })
	}
	return browser
}

/**
 * Open a fresh isolated context + page for a scenario, reusing the shared
 * browser. Called from `beforeAll`. Any context left over from a previous
 * scenario whose teardown didn't complete is closed first so state never
 * bleeds across scenarios.
 */
export async function launchPage(label?: string, opts?: { roles?: string[]; baseUrl?: string }): Promise<Page> {
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
	// Resolve the scenario's roles to a stored session (cookies + localStorage) and
	// seed the context with it, so the walkthrough opens already authenticated. Null
	// when there's no auth provider or the role is a logged-out one — then it's a
	// plain fresh context, exactly as before. `baseUrl` scopes the session cache per
	// environment, so a session minted against stage isn't reused against local.
	const storageState = await resolveStorageState(opts?.roles, b, undefined, opts?.baseUrl)
	const video = videoConfig()
	if (video) warnRecordingTiming()
	context = await b.newContext({
		...(video
			? {
				recordVideo: { dir: VIDEO_RAW_DIR, ...(video.size ? { size: video.size } : {}) },
				...(video.size ? { viewport: video.size } : {}),
			}
			: {}),
		...(storageState ? { storageState } : {}),
	})
	// Draw the synthetic cursor on every page of this context, before any app
	// code runs, so the whole walkthrough (including full navigations) shows it.
	if (video?.cursor) await context.addInitScript(CURSOR_SCRIPT)
	currentVideoLabel = video ? slugify(label ?? 'scenario', 'scenario') : null
	currentVideoName = video ? (label ?? 'scenario') : null
	videoSteps = []
	page = await context.newPage()
	// t=0 reference for the manifest: the recording starts with this page.
	videoStartMs = Date.now()
	return page
}

/**
 * Record one executed step into the recording's timeline. No-op unless a video
 * is being recorded. Called from the scenario runner after each step so the
 * sidecar manifest carries `{ name, start, duration, cursor }` for every step.
 * The cursor anchor is read from the synthetic cursor element (best-effort — the
 * page may be mid-navigation).
 */
export async function recordVideoStep(s: { name: string; kind: string; sequence: number; startMs: number; durationMs: number; status: string }): Promise<void> {
	if (!currentVideoLabel || !page) return
	let cursor: { x: number; y: number } | undefined
	try {
		const raw = await page.evaluate(
			`(() => { const c = document.getElementById('__opice_cursor'); if (!c) return null; const x = parseFloat(c.style.left), y = parseFloat(c.style.top); return (isFinite(x) && isFinite(y)) ? { x, y } : null; })()`,
		)
		if (raw && typeof raw === 'object' && 'x' in raw && 'y' in raw) {
			cursor = { x: Number((raw as { x: unknown }).x), y: Number((raw as { y: unknown }).y) }
		}
	} catch {
		// Page navigating / closed — cursor anchor is optional.
	}
	videoSteps.push({
		name: s.name,
		kind: s.kind,
		sequence: s.sequence,
		tStartMs: Math.max(0, s.startMs - videoStartMs),
		durationMs: s.durationMs,
		status: s.status,
		...(cursor ? { cursor } : {}),
	})
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
	const name = currentVideoName
	const steps = videoSteps
	const viewport = page?.viewportSize() ?? undefined
	try {
		await context?.close()
	} finally {
		page = null
		context = null
		currentVideoLabel = null
		currentVideoName = null
		videoSteps = []
		videoStartMs = 0
	}
	if (!video || !label) return undefined
	const cfg = videoConfig()
	const dir = cfg?.dir ?? 'opice-videos'
	const target = path.join(dir, `${uniqueVideoStem(label)}.webm`)
	// Saving the .webm is the part that matters — it's what gets uploaded to R2.
	let saved = false
	try {
		await fs.mkdir(dir, { recursive: true })
		await video.saveAs(target)
		saved = true
	} catch (e) {
		console.warn(`[opice] failed to save video for "${label}" (ignored): ${e instanceof Error ? e.message : String(e)}`)
	} finally {
		// Drop the raw hash-named copy under the scratch dir.
		await video.delete().catch(() => {})
	}
	if (!saved) return undefined
	// The sidecar manifest is a nice-to-have for post-production; a failure to
	// write it must NOT discard the successfully-saved video (which would skip the
	// R2 upload and leave the dashboard with no recording for the scenario).
	try {
		const manifest: VideoManifest = {
			scenario: name ?? label,
			video: path.basename(target),
			...(cfg?.size ?? viewport ? { size: cfg?.size ?? viewport } : {}),
			steps,
		}
		await fs.writeFile(target.replace(/\.webm$/, '.json'), `${JSON.stringify(manifest, null, 2)}\n`)
	} catch (e) {
		console.warn(`[opice] saved video for "${label}" but failed to write its manifest (ignored): ${e instanceof Error ? e.message : String(e)}`)
	}
	return target
}

// Graceful shutdown of the shared browser when the test process winds down. If
// this doesn't fire (hard exit/signal), Playwright's own exit handler still
// kills the chromium child, so the process never outlives the run.
process.once('beforeExit', () => {
	const b = browser
	browser = null
	void b?.close().catch(() => {})
})
