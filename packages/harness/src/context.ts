import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

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

/** Headed mode for local debugging (`OPICE_HEADED=1` or Playwright's `PWDEBUG`). */
function headed(): boolean {
	return !!(process.env['OPICE_HEADED'] || process.env['PWDEBUG'])
}

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
export async function launchPage(): Promise<Page> {
	if (context) {
		await context.close().catch(() => {})
		context = null
		page = null
	}
	const b = await getBrowser()
	context = await b.newContext()
	page = await context.newPage()
	return page
}

/**
 * Close the scenario's context (and page); keep the shared browser alive for
 * the next scenario. Called from `afterAll`. The browser itself is launched
 * once and reaped by Playwright's own process-exit handler when `bun test`
 * exits — see the `beforeExit` hook below for the graceful path.
 */
export async function closePage(): Promise<void> {
	try {
		await context?.close()
	} finally {
		page = null
		context = null
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
