import { pathToFileURL } from 'node:url'
import type { Locator, Page } from 'playwright'
import { z } from 'zod'
import { getPage } from './context.js'
import { findUserFile } from './find-file.js'
import { locatorOn } from './element.js'

/**
 * The shared command registry.
 *
 * A command is a named, schema-validated browser verb implemented once over a
 * Playwright page. The same command object is used on both faces:
 *
 * - **authoring** — the `opice-browser` daemon loads it and exposes it to the
 *   agent (`opice-browser <name> …`),
 * - **tests** — the harness loads the same module so a test can call the verb
 *   directly.
 *
 * Built-in verbs (open/click/fill/byRole/…) ship with the `opice-browser`
 * daemon; user-land verbs live in a repo's `browser-tools.ts` and are picked up
 * by `loadUserCommands`. Both are the *same* `Command` objects — that is the
 * unification that closes the authoring↔test vocabulary gap.
 */

/** Page + accessibility-aware helpers handed to every command implementation. */
export interface CommandCtx {
	page: Page
	/** Resolve a test-id (bare word) or raw CSS selector to a locator. */
	el(selectorOrTestId: string): Locator
	byRole(role: Parameters<Page['getByRole']>[0], name?: string): Locator
	byLabel(text: string): Locator
	byText(text: string): Locator
}

export interface Command<S extends z.ZodType = z.ZodType> {
	name: string
	/** One-line description, surfaced in `opice-browser commands`. */
	description?: string
	params: S
	run: (ctx: CommandCtx, args: z.infer<S>) => Promise<unknown>
}

/** Define a browser command. See `CommandCtx` for what `ctx` provides. */
export function command<S extends z.ZodType>(
	name: string,
	params: S,
	run: (ctx: CommandCtx, args: z.infer<S>) => Promise<unknown>,
	description?: string,
): Command<S> {
	return { name, params, run, description }
}

/** Build the command context bound to a specific page. */
export function makeCtx(page: Page): CommandCtx {
	return {
		page,
		el: (sel) => locatorOn(page, sel),
		byRole: (role, name) => page.getByRole(role, name == null ? undefined : { name }),
		byLabel: (text) => page.getByLabel(text),
		byText: (text) => page.getByText(text),
	}
}

/** Validate args against a command's schema and run it on `page`. */
export async function runCommand(page: Page, cmd: Command, rawArgs: unknown): Promise<unknown> {
	const args = cmd.params.parse(rawArgs)
	return cmd.run(makeCtx(page), args)
}

/**
 * Invoke a command against the active scenario page from inside a test. Pair
 * with a direct import of the verb from `browser-tools.ts` so the args are
 * type-checked against its schema:
 *
 * ```ts
 * import { call } from '@opice/harness'
 * import { fullEnum } from '../browser-tools'
 * await call(fullEnum, { label: 'Typ', option: 'Faktura' })
 * ```
 */
export async function call<S extends z.ZodType>(cmd: Command<S>, args: z.infer<S>): Promise<unknown> {
	return runCommand(getPage(), cmd, args)
}

/** Duck-type check: is a module export a `Command`? */
function isCommand(value: unknown): value is Command {
	return (
		typeof value === 'object'
		&& value !== null
		&& typeof (value as Command).name === 'string'
		&& typeof (value as Command).run === 'function'
		&& 'params' in value
	)
}

/**
 * Locate a repo's `browser-tools.ts` (or `.js`/`.mjs`), walking up from `from`
 * but never above the repository root (see {@link findUserFile} — this file is
 * imported and executed). Returns the absolute path, or null if none is found.
 */
export function findUserCommandsFile(from?: string): string | null {
	return findUserFile(['browser-tools.ts', 'browser-tools.js', 'browser-tools.mjs'], from)
}

/**
 * Load user-land commands from a repo's `browser-tools.ts`. Returns a map keyed
 * by command name (empty if the file is absent). Throws on a duplicate name.
 */
export async function loadUserCommands(from?: string): Promise<Map<string, Command>> {
	const registry = new Map<string, Command>()
	const file = findUserCommandsFile(from)
	if (!file) return registry
	const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
	for (const value of Object.values(mod)) {
		if (!isCommand(value)) continue
		if (registry.has(value.name)) {
			throw new Error(`browser-tools.ts: duplicate command name "${value.name}" (${file})`)
		}
		registry.set(value.name, value)
	}
	return registry
}

export { z }
