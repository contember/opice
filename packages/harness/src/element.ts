import type { Locator, Page } from 'playwright'
import { getPage } from './context.js'

const POLL_INTERVAL = 200
const POLL_TIMEOUT = 10_000

/**
 * Resolve a selector into a `Locator` on an explicit page — the shared core
 * behind `el()` and the command-registry context. Bare identifiers become
 * test-ids (`getByTestId`, matching `data-testid`); anything with CSS-flavoured
 * characters (`[ ] . # : > ` or a space) is a raw CSS selector.
 */
export function locatorOn(page: Page, selectorOrTestId: string): Locator {
	if (/[\[\].#:> ]/.test(selectorOrTestId)) {
		return page.locator(selectorOrTestId)
	}
	return page.getByTestId(selectorOrTestId)
}

/**
 * Resolve a selector into a Playwright `Locator`.
 *
 * Bare identifiers are auto-wrapped as test-ids (`page.getByTestId`, which
 * matches `data-testid` by default); anything with CSS-flavoured characters
 * (`[ ] . # : > ` or a space) is treated as a raw CSS selector. Heuristic — if
 * you need a plain-tag selector (e.g. `h1`), give it structure (`main h1`).
 *
 * The returned value is a real Playwright `Locator`, so the full Locator API
 * (`.click()`, `.fill()`, `.textContent()`, `.first()`, `.nth()`, …) and the
 * web-first `expect(locator)` assertions are available. All actions auto-wait
 * for actionability and fire real user gestures.
 */
export function el(selectorOrTestId: string): Locator {
	return locatorOn(getPage(), selectorOrTestId)
}

/**
 * Build a `[data-testid="..."]` selector string, for composing into a larger
 * CSS selector: `el(`${tid('row')} button`)`. For a plain test-id, prefer
 * `el('row')` directly.
 */
export function tid(testId: string): string {
	return `[data-testid="${testId}"]`
}

/**
 * Poll a (possibly async) condition until it returns true or times out.
 *
 * Prefer Playwright's retrying assertions — `await expect(el('x')).toBeVisible()`,
 * `.toHaveText(...)` — which auto-wait and give better failure messages. Keep
 * `waitFor` for arbitrary predicates that don't map to a locator assertion.
 */
export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	{ timeout = POLL_TIMEOUT, interval = POLL_INTERVAL, message }: { timeout?: number; interval?: number; message?: string } = {},
): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		try {
			if (await condition()) return
		} catch {
			// condition threw — treat as not yet ready
		}
		await new Promise((resolve) => setTimeout(resolve, interval))
	}
	if (!(await condition())) {
		const elapsed = Date.now() - start
		const hint = message ?? condition.toString().slice(0, 120)
		throw new Error(`waitFor timed out after ${elapsed}ms: ${hint}`)
	}
}

/** Fixed sleep. Avoid when possible — prefer `waitFor` or retrying assertions. */
export async function wait(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Evaluate JavaScript in the page and return its result. Thin wrapper over
 * `page.evaluate`; the value is the real JS value (not a JSON string).
 */
export function evalJs<T = unknown>(js: string): Promise<T> {
	return getPage().evaluate(js) as Promise<T>
}

/** Capture a screenshot to `path` (or a temp file) and return the path. */
export async function screenshot(path?: string): Promise<string> {
	const target = path ?? `/tmp/opice-screenshot-${Date.now()}.png`
	await getPage().screenshot({ path: target })
	return target
}
