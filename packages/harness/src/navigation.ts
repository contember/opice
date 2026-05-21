import { exec } from './agent-browser.js'
import { evalJs } from './element.js'

/**
 * Page navigation primitives. `browserTest` opens the scenario URL for you in
 * `beforeAll`; these are for mid-scenario navigation — following a hard link,
 * reloading after mutating storage/cookies, or going back/forward.
 *
 * Note on reload: a reload triggered from inside `evalJs('location.reload()')`
 * is dropped by agent-browser (the eval's execution context is torn down before
 * the navigation commits), so `reload()` shells out to the CLI instead. Use it
 * after writing auth tokens to localStorage/cookies so the app re-reads them.
 */

/** Navigate to a URL in the current session. */
export function open(url: string): void {
	exec(`agent-browser open ${url}`)
}

/** Reload the current page (and wait for the CLI to settle). */
export function reload(): void {
	exec('agent-browser reload')
}

/** Go back in history. */
export function back(): void {
	exec('agent-browser back')
}

/** Go forward in history. */
export function forward(): void {
	exec('agent-browser forward')
}

/** The current full URL (`location.href`). */
export function currentUrl(): string {
	return readLocation('href')
}

/** The current path (`location.pathname`). */
export function currentPath(): string {
	return readLocation('pathname')
}

function readLocation(prop: 'href' | 'pathname'): string {
	const raw = evalJs(`location.${prop}`)
	try {
		const value: unknown = JSON.parse(raw)
		return typeof value === 'string' ? value : raw
	} catch {
		return raw
	}
}
