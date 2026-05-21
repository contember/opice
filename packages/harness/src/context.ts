import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

/**
 * The live Playwright page for the running scenario. `browserTest` launches a
 * fresh browser + context + page per scenario (`beforeAll`) and tears it down
 * (`afterAll`); the DSL — `el`, `byRole`, navigation — reads the current page
 * from here. This module replaces the old agent-browser CLI session handling:
 * there is no shell-out and no daemon, the browser runs in-process under
 * `bun test`.
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

/** Launch a fresh isolated browser + context + page. Called from `beforeAll`. */
export async function launchPage(): Promise<Page> {
	browser = await chromium.launch({ headless: !headed() })
	context = await browser.newContext()
	page = await context.newPage()
	return page
}

/** Close the page, context, and browser. Called from `afterAll`. */
export async function closePage(): Promise<void> {
	try {
		await context?.close()
	} finally {
		await browser?.close()
		page = null
		context = null
		browser = null
	}
}
