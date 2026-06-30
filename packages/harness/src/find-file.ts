import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** Is `ancestor` the same as, or a parent of, `p`? Both are resolved first. */
function isAncestorOrSelf(ancestor: string, p: string): boolean {
	const a = path.resolve(ancestor)
	const b = path.resolve(p)
	if (a === b) return true
	const rel = path.relative(a, b)
	if (rel === '' || path.isAbsolute(rel)) return false
	// `b` is outside `a` iff the relative path steps UP — i.e. its first SEGMENT is
	// exactly `..` (not merely starts with the chars `..`, which a dir named
	// `..cache` would). A true descendant never has a `..` first segment.
	return rel.split(path.sep)[0] !== '..'
}

/** A directory that is a project root — it holds a `.git` or a `package.json`. */
function hasProjectMarker(dir: string): boolean {
	return existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, 'package.json'))
}

/**
 * The directory the upward search must not climb above — the project root. This
 * is a SECURITY boundary: the files {@link findUserFile} locates
 * (`browser-auth.ts`, `browser-setup.ts`, `browser-tools.ts`) are dynamically
 * `import()`ed and executed, and `browser-auth.ts` returns session cookies that
 * are injected into every scenario, so resolving one from OUTSIDE the project (a
 * shared CI `$HOME`, a `/tmp` parent of a clone, a stray file in a developer's
 * home) is arbitrary code execution and forged sessions.
 *
 * The ceiling is the NEAREST enclosing project marker (`.git` or `package.json`).
 * That is what makes this safe without any `$HOME`/filesystem-root special-casing:
 * a real project ALWAYS has a marker at its own root, which sits below the user's
 * home, so the nearest marker walking up from a subdirectory IS the project root —
 * the search physically cannot climb past it into `$HOME` or a shared parent. If
 * no marker is found all the way up (the directory isn't inside a project at all),
 * the search is confined to `start` and climbs nowhere.
 *
 * `OPICE_PROJECT_ROOT` overrides this, but ONLY when it is an ancestor of `start`
 * AND is itself a project root (holds a marker) — so it can be pointed at a
 * monorepo/superproject root above a submodule, but never at a bare shared parent
 * like `/home` (which holds no marker) to widen the search into other users' dirs.
 */
function projectCeiling(start: string): string {
	const explicit = process.env['OPICE_PROJECT_ROOT']
	if (explicit) {
		const e = path.resolve(explicit)
		if (isAncestorOrSelf(e, start) && hasProjectMarker(e)) return e
	}
	for (let dir = start; ; dir = path.dirname(dir)) {
		if (hasProjectMarker(dir)) return dir
		const parent = path.dirname(dir)
		if (parent === dir) return start // filesystem root, no marker → confine to `start`
	}
}

/**
 * Walk up from `from` looking for the first of `names`, **bounded to the project
 * root** (see {@link projectCeiling} — this boundary is a security control). The
 * ceiling directory itself IS searched (a `browser-auth.ts` next to `.git` at the
 * repo root is found), but nothing above it is.
 */
export function findUserFile(names: readonly string[], from: string = process.cwd()): string | null {
	const start = path.resolve(from)
	const ceiling = projectCeiling(start)
	for (let dir = start; ; dir = path.dirname(dir)) {
		for (const name of names) {
			const candidate = path.join(dir, name)
			if (existsSync(candidate)) return candidate
		}
		// `ceiling` is always `start` or an ancestor of it, so this is always reached.
		if (dir === ceiling) return null
	}
}

/**
 * Load a single exported function from a user config module — the shared half of
 * `loadUserAuth` / `loadUserSetup` (the `find-file` half is {@link findUserFile}).
 *
 * Mirrors the historical `mod[name] ?? mod.default` selection EXACTLY: the first
 * named export that is present (non-nullish) wins even if it is not a function —
 * in which case this returns null (the typecheck fails), rather than silently
 * falling through to `default`. `default` is only consulted when every named
 * export is absent. Returns the resolved function + the file's directory, or null.
 */
export async function loadUserExport(
	file: string | null,
	names: readonly string[],
): Promise<{ fn: (...args: never[]) => unknown; dir: string } | null> {
	if (!file) return null
	const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
	let candidate: unknown
	for (const name of names) {
		if (mod[name] != null) {
			candidate = mod[name]
			break
		}
	}
	if (candidate == null) candidate = mod['default']
	return typeof candidate === 'function' ? { fn: candidate as (...args: never[]) => unknown, dir: path.dirname(file) } : null
}
