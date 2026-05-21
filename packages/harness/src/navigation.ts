import { getPage } from './context.js'

/**
 * Page navigation primitives. `browserTest` opens the scenario URL for you in
 * `beforeAll`; these are for mid-scenario navigation — following a hard link,
 * reloading after mutating storage/cookies, or going back/forward.
 *
 * Each navigating call waits for the `load` event (Playwright's default), so
 * the old agent-browser reload caveat (a reload from inside `eval` getting
 * dropped) no longer applies — `reload()` drives the page directly.
 */

/** Navigate to a URL in the current page. */
export async function open(url: string): Promise<void> {
	await getPage().goto(url)
}

/** Reload the current page. */
export async function reload(): Promise<void> {
	await getPage().reload()
}

/** Go back in history. */
export async function back(): Promise<void> {
	await getPage().goBack()
}

/** Go forward in history. */
export async function forward(): Promise<void> {
	await getPage().goForward()
}

/** The current full URL (`location.href`). */
export function currentUrl(): string {
	return getPage().url()
}

/** The current path (`location.pathname`). */
export function currentPath(): string {
	return new URL(getPage().url()).pathname
}
