import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserContext } from 'playwright'

/**
 * Repo-level browser context setup — the context analog of `browser-tools.ts`.
 *
 * A repo may export a `setup(context)` from `browser-setup.ts`; opice runs it
 * against the freshly-created `BrowserContext` **before the first navigation**,
 * on both faces:
 *
 * - **tests** — `browserTest` runs it in `beforeAll`, after launching the
 *   context but before `page.goto`,
 * - **authoring** — the `opice-browser` server runs it once after connecting,
 *   before navigating to the launch URL.
 *
 * Because it runs pre-navigation, an `addInitScript` registered here executes
 * before the app's own scripts on the very first paint — the right place to
 * seed storage/cookies, grant permissions, or set a flag the app reads at boot
 * (e.g. "this is an automated run — don't render dev-only chrome"). Keep the
 * body idempotent: it may run more than once over a context's life.
 */
export type BrowserSetup = (context: BrowserContext) => void | Promise<void>

/**
 * Locate a repo's `browser-setup.ts` (or `.js`/`.mjs`), walking up from `from`.
 * Returns the absolute path, or null if none is found before the filesystem root.
 */
export function findUserSetupFile(from: string = process.cwd()): string | null {
	let dir = path.resolve(from)
	for (;;) {
		for (const name of ['browser-setup.ts', 'browser-setup.js', 'browser-setup.mjs']) {
			const candidate = path.join(dir, name)
			if (existsSync(candidate)) return candidate
		}
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

/**
 * Load a repo's `browser-setup.ts` and return its setup function (the `setup`
 * named export, or the default export), or null if there is no such file or it
 * doesn't export a function.
 */
export async function loadUserSetup(from?: string): Promise<BrowserSetup | null> {
	const file = findUserSetupFile(from)
	if (!file) return null
	const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
	const fn = mod['setup'] ?? mod['default']
	return typeof fn === 'function' ? (fn as BrowserSetup) : null
}
