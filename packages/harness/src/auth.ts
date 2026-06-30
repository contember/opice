import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext } from 'playwright'
import { isTruthy } from './env.js'
import { findUserFile, loadUserExport } from './find-file.js'
import { slugify } from './slug.js'

/**
 * Role-driven authentication — the reason a scenario no longer has to sign in by
 * hand.
 *
 * A scenario declares who it acts as (`roles: ['member']`); the harness asks a
 * repo-provided auth provider to turn each role into a Playwright **storage
 * state** (cookies + per-origin localStorage), persists it to a file, and seeds
 * the scenario's context with it at creation time. The scenario then navigates
 * straight to its target URL already authenticated — no login step in the body.
 *
 * The harness owns the plumbing (cache file, persistence, injection); the repo
 * owns the meaning of a role. Only the repo knows how to log in, whether a
 * cached session is still valid (reuse it) or must be refreshed (the probe
 * 401s), and what a role like `'new-user'` means — return an EMPTY state and the
 * scenario starts logged-out and registers itself (the new-user journey IS the
 * test). With no `browser-auth.ts` present, this whole layer is inert and every
 * scenario behaves exactly as before (a fresh, cookieless context).
 */

/** Playwright's persisted storage state (cookies + per-origin localStorage). */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>
type Cookie = StorageState['cookies'][number]
type Origin = StorageState['origins'][number]

/** Context handed to a repo auth provider while it resolves one role. */
export interface AuthResolveContext {
	/** Previously-persisted state for this role, or null on a cold cache / forced refresh. */
	cached: StorageState | null
	/** The shared browser — open a throwaway context on it to perform a login. */
	browser: Browser
}

/**
 * Repo-provided auth resolver. Given a role (and any cached state), returns a
 * valid storage state to seed the scenario's context with. The repo decides
 * whether `cached` is still good (return it unchanged — opice then skips the
 * re-write) or must be refreshed (log in again and return the fresh state), and
 * what each role means:
 *
 * - return a populated state → inject it (the scenario opens authenticated),
 * - return an EMPTY state (`{ cookies: [], origins: [] }`) → a logged-out role:
 *   nothing is injected and the scenario signs itself in (the sign-up journey),
 * - return `null`/`undefined` → "this isn't an auth role" (a free-text label the
 *   provider doesn't own): the harness treats it as a pure annotation and skips
 *   it, so adding an auth provider never breaks scenarios whose `roles` were only
 *   ever documentation.
 */
export type BrowserAuth = (role: string, ctx: AuthResolveContext) => Promise<StorageState | null | undefined>

interface LoadedAuth {
	authenticate: BrowserAuth
	/** Directory of the resolved `browser-auth.ts`; the cache lives under it. */
	dir: string
}

const AUTH_FILES = ['browser-auth.ts', 'browser-auth.js', 'browser-auth.mjs'] as const

/**
 * Locate a repo's `browser-auth.ts` (or `.js`/`.mjs`), walking up from `from`
 * but **never above the project root** — see {@link findUserFile} for why that
 * boundary is a security control (this file is imported and executed).
 */
export function findUserAuthFile(from?: string): string | null {
	return findUserFile(AUTH_FILES, from)
}

/**
 * Load a repo's `browser-auth.ts` and return its resolver (the `authenticate`
 * named export, or the default export), or null if there is no such file or it
 * doesn't export a function. NOT memoized — the upward file walk is a handful of
 * cheap `existsSync` calls and the module import is cached by the ESM loader, so
 * re-resolving per scenario is immaterial next to launching a browser context,
 * and a cache here previously mis-pinned transient import failures / incomplete
 * files for the whole process.
 */
export async function loadUserAuth(from?: string): Promise<LoadedAuth | null> {
	const loaded = await loadUserExport(findUserAuthFile(from), ['authenticate'])
	return loaded ? { authenticate: loaded.fn as BrowserAuth, dir: loaded.dir } : null
}

/** Short stable hash, so distinct role/origin pairs never share a cache file. */
function hash8(s: string): string {
	return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

/**
 * Cache filename for a (role, origin) pair. The readable `slugify(role)` stem is
 * for humans; the hash suffix carries the FULL role and origin, so two roles that
 * slug alike (`team/lead` vs `team-lead`, `admin` vs `admin!`) — or the same role
 * run against different environments — never collide on one file (which would
 * make a scenario run as the wrong identity, or carry a stale cross-environment
 * session).
 */
function cacheFile(dir: string, role: string, origin: string | undefined): string {
	const key = `${slugify(role, 'role')}-${hash8(origin ? `${role} ${origin}` : role)}`
	return path.join(dir, '.opice', 'auth', `${key}.json`)
}

/** The raw cache file contents (the exact bytes on disk), or null if absent/unreadable. */
async function readCacheRaw(file: string): Promise<string | null> {
	try {
		return await fs.readFile(file, 'utf8')
	} catch {
		// Missing or unreadable cache — treat as a cold start.
		return null
	}
}

/** Parse cached JSON, or null if it's corrupt (treated as a cold start). */
function safeParse(raw: string): StorageState | null {
	try {
		return JSON.parse(raw) as StorageState
	} catch {
		return null
	}
}


async function ensureGitignore(dir: string): Promise<void> {
	const gi = path.join(dir, '.gitignore')
	try {
		// Already ignores everything (`*` on its own line)? leave it.
		if (/^\s*\*\s*$/m.test(await fs.readFile(gi, 'utf8'))) return
	} catch {
		// missing — fall through and write it
	}
	await fs
		.writeFile(gi, '# opice persists live session cookies here — never commit them.\n*\n', { mode: 0o600 })
		.catch(() => {})
}

/**
 * Persist a role's session from its already-serialized form. The cache holds LIVE
 * auth secrets (session cookies + localStorage), so the file is written private
 * (0600, plus a `chmod` after write to defeat the umask) under a directory that is
 * itself 0700 and gitignored. The dir is created AND hardened (chmod + gitignore)
 * on every write — not memoized — so a dir recreated after a mid-run cleanup is
 * always re-hardened (the three ops are cheap + idempotent). A no-op on Windows
 * for the mode bits (best-effort).
 */
async function writeCache(file: string, serialized: string): Promise<void> {
	const dir = path.dirname(file)
	// Create + harden on every write (not memoized): all three are cheap and
	// idempotent (mkdir recursive ≈ a stat; ensureGitignore early-returns once the
	// `*` rule is present; chmod is one syscall), and doing it every time means a
	// dir recreated after a mid-run cleanup is ALWAYS re-hardened — never left
	// holding a secret file with no .gitignore.
	await fs.mkdir(dir, { recursive: true })
	await Promise.all([fs.chmod(dir, 0o700).catch(() => {}), ensureGitignore(dir)])
	await fs.writeFile(file, serialized, { mode: 0o600 })
	await fs.chmod(file, 0o600).catch(() => {})
}

/** A state with no cookies and no origins means "stay logged-out" — inject nothing. */
function isEmptyState(s: StorageState): boolean {
	return (s.cookies?.length ?? 0) === 0 && (s.origins?.length ?? 0) === 0
}

/**
 * Surface a genuine cross-role identity clash. By default this is a loud WARNING
 * + last-wins: a hard throw would break legitimate multi-role merges where the
 * shared key is a benign rotating cookie. Set `OPICE_AUTH_STRICT=1` to make it a
 * hard failure instead (CI that wants a two-identity mistake to red the run).
 */
function reportIdentityConflict(kind: string, roleA: string, roleB: string, what: string, where: string): void {
	const message = `roles '${roleA}' and '${roleB}' both set ${kind} '${what}' for ${where} with different values — `
		+ `a single browser context can hold only one identity. Keeping '${roleB}'. If these are genuinely different `
		+ `users, split them into separate scenarios (or set OPICE_AUTH_STRICT=1 to fail on this).`
	if (isTruthy(process.env['OPICE_AUTH_STRICT'])) throw new Error(`opice: ${message}`)
	console.warn(`[opice] ${message}`)
}

/**
 * Merge several roles' states into one to seed a single context. A single role is
 * returned as-is (the common case — no allocation, no comparison). For MULTIPLE
 * roles we UNION at the granularity a context actually holds one of: per cookie
 * (name+domain+path) and per localStorage key (origin+name). Disjoint
 * contributions combine cleanly; a clash is detected by comparing the VALUE (the
 * bit that carries identity, not incidental cookie attributes) and resolved
 * last-wins, reported via {@link reportIdentityConflict} (warn by default, throw
 * under OPICE_AUTH_STRICT) so a real two-identity mistake is never silent.
 */
function mergeStates(entries: Array<{ role: string; state: StorageState }>): StorageState {
	if (entries.length === 1) return entries[0]!.state

	const cookies = new Map<string, { role: string; cookie: Cookie }>()
	// origin → its merged state. `extra` carries every per-origin field OTHER than
	// localStorage — notably Playwright's `indexedDB`, which is absent from the
	// public storageState() type but present at runtime when a provider captures it
	// with `storageState({ indexedDB: true })` (auth libraries like Firebase keep
	// the session there). Rebuilding origins as a bare `{ origin, localStorage }`
	// would silently drop it, breaking IndexedDB-backed sessions; we preserve it by
	// shallow-merging the non-localStorage fields last-wins, so a later role that
	// contributes only localStorage can't clobber an earlier role's indexedDB.
	const origins = new Map<string, { extra: Record<string, unknown>; byName: Map<string, { role: string; item: Origin['localStorage'][number] }> }>()

	for (const { role, state } of entries) {
		for (const c of state.cookies ?? []) {
			const key = `${c.name}\t${c.domain}\t${c.path}`
			const prev = cookies.get(key)
			if (prev && prev.role !== role && prev.cookie.value !== c.value) {
				reportIdentityConflict('cookie', prev.role, role, c.name, c.domain)
			}
			cookies.set(key, { role, cookie: c })
		}
		for (const o of state.origins ?? []) {
			let entry = origins.get(o.origin)
			if (!entry) {
				entry = { extra: {}, byName: new Map() }
				origins.set(o.origin, entry)
			}
			// Accumulate every field except localStorage (which we union below);
			// later contributors override earlier ones field-by-field, but an
			// omitted field never erases a value an earlier role supplied.
			const { localStorage, ...rest } = o as Origin & Record<string, unknown>
			Object.assign(entry.extra, rest)
			for (const item of localStorage ?? []) {
				const prev = entry.byName.get(item.name)
				if (prev && prev.role !== role && prev.item.value !== item.value) {
					reportIdentityConflict('localStorage key', prev.role, role, item.name, o.origin)
				}
				entry.byName.set(item.name, { role, item })
			}
		}
	}

	return {
		cookies: [...cookies.values()].map(v => v.cookie),
		origins: [...origins.entries()].map(([origin, entry]) => ({
			...entry.extra,
			origin,
			localStorage: [...entry.byName.values()].map(v => v.item),
		})) as StorageState['origins'],
	}
}

/**
 * Resolve a scenario's `roles` to a single storage state to seed its context,
 * or null when there's nothing to inject (no provider, no roles, or every role
 * resolved to an empty/logged-out/annotation state). For each role: load the
 * cached state, hand it to the repo provider (which reuses or refreshes it),
 * persist whatever comes back (skipping the write when it's the unchanged cached
 * object), and collect the non-empty ones. `baseUrl` scopes the cache per
 * environment (its origin is folded into the cache key), so a session minted
 * against stage is never injected into a local run. `OPICE_AUTH_REFRESH=1` forces
 * a cold resolve (ignores the cache) for the run.
 */
export async function resolveStorageState(
	roles: string[] | undefined,
	browser: Browser,
	from?: string,
	baseUrl?: string,
): Promise<StorageState | null> {
	if (!roles || roles.length === 0) return null
	const loaded = await loadUserAuth(from)
	if (!loaded) return null

	let origin: string | undefined
	try {
		origin = baseUrl ? new URL(baseUrl).origin : undefined
	} catch {
		origin = undefined
	}

	const forceRefresh = isTruthy(process.env['OPICE_AUTH_REFRESH'])
	const entries: Array<{ role: string; state: StorageState }> = []
	// Roles resolve SEQUENTIALLY on purpose: the provider's login runs arbitrary
	// repo code (often opening throwaway contexts on the shared browser), and a
	// scenario rarely declares more than one role — serial keeps provider logins
	// from racing each other on the same browser for a saving that almost never matters.
	for (const role of roles) {
		const file = cacheFile(loaded.dir, role, origin)
		// Keep the exact bytes on disk so we can tell "unchanged" from "refreshed"
		// even when the provider rotates a session by mutating the cached object in
		// place and returning the same reference.
		const rawCached = forceRefresh ? null : await readCacheRaw(file)
		const cached = rawCached !== null ? safeParse(rawCached) : null
		const state = await loaded.authenticate(role, { cached, browser })
		// null/undefined ⇒ a non-auth annotation the provider doesn't own; empty
		// ⇒ an intentional logged-out role. Either way: persist nothing, inject nothing.
		if (!state || isEmptyState(state)) continue
		// Persist unless the serialized session is byte-identical to what's on disk
		// (a warm run that reused an unchanged session) — this still writes a session
		// the provider refreshed by mutating `cached`, since its bytes now differ.
		const serialized = JSON.stringify(state, null, 2)
		if (serialized !== rawCached) await writeCache(file, serialized)
		entries.push({ role, state })
	}
	if (entries.length === 0) return null
	return mergeStates(entries)
}
