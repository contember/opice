import { afterEach, beforeEach, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Browser } from 'playwright'
import { resolveStorageState, type StorageState } from './auth.js'

// resolveStorageState passes the browser straight to the repo provider; the
// fixture provider below ignores it, so a bare stub is enough for these tests.
const browser = {} as unknown as Browser

const memberState: StorageState = {
	cookies: [{ name: 'session_token', value: 'abc', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
	origins: [],
}

let dir: string
beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(tmpdir(), 'opice-auth-test-'))
})
afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

// Write a `browser-auth.js` into the fixture dir. Its provider logs every call to
// `calls.json` (so the test can assert what it was asked) and answers by role.
async function writeProvider(): Promise<void> {
	const code = `
import { promises as fs } from 'node:fs'
import path from 'node:path'
const logFile = path.join(import.meta.dirname, 'calls.json')
const member = ${JSON.stringify(memberState)}
export async function authenticate(role, ctx) {
	const log = JSON.parse(await fs.readFile(logFile, 'utf8').catch(() => '[]'))
	log.push({ role, cachedPresent: !!ctx.cached })
	await fs.writeFile(logFile, JSON.stringify(log))
	if (role === 'new-user') return { cookies: [], origins: [] }
	return member
}
`
	await fs.writeFile(path.join(dir, 'browser-auth.js'), code)
	await fs.writeFile(path.join(dir, 'calls.json'), '[]')
}

const readCalls = async (): Promise<Array<{ role: string; cachedPresent: boolean }>> =>
	JSON.parse(await fs.readFile(path.join(dir, 'calls.json'), 'utf8'))

// The cache filename is `<slug>-<hash>.json` (hash of role + origin), not a bare
// role name, so tests locate the persisted session by scanning the auth dir for
// JSON files rather than hardcoding the stem.
const authDir = () => path.join(dir, '.opice', 'auth')
const cacheJsonFiles = async (): Promise<string[]> => {
	try {
		return (await fs.readdir(authDir())).filter(f => f.endsWith('.json'))
	} catch {
		return []
	}
}
const readOnlyCache = async (): Promise<StorageState> => {
	const files = await cacheJsonFiles()
	expect(files).toHaveLength(1)
	return JSON.parse(await fs.readFile(path.join(authDir(), files[0]!), 'utf8'))
}

test('no roles → null, provider never consulted', async () => {
	await writeProvider()
	expect(await resolveStorageState([], browser, dir)).toBeNull()
	expect(await resolveStorageState(undefined, browser, dir)).toBeNull()
	expect(await readCalls()).toEqual([])
})

test('no provider file → null', async () => {
	// empty fixture dir, no browser-auth.js
	expect(await resolveStorageState(['member'], browser, dir)).toBeNull()
})

test('cold member → provider called with no cache, state injected and persisted', async () => {
	await writeProvider()
	const state = await resolveStorageState(['member'], browser, dir)
	expect(state?.cookies?.[0]?.name).toBe('session_token')
	expect(await readCalls()).toEqual([{ role: 'member', cachedPresent: false }])
	// persisted for next run
	expect(await readOnlyCache()).toEqual(memberState)
})

test('warm member → cached state is read back and handed to the provider', async () => {
	await writeProvider()
	await resolveStorageState(['member'], browser, dir) // cold: writes cache
	await resolveStorageState(['member'], browser, dir) // warm: should pass cached
	expect(await readCalls()).toEqual([
		{ role: 'member', cachedPresent: false },
		{ role: 'member', cachedPresent: true },
	])
})

test('OPICE_AUTH_REFRESH forces a cold resolve even with a warm cache', async () => {
	await writeProvider()
	await resolveStorageState(['member'], browser, dir) // writes cache
	process.env['OPICE_AUTH_REFRESH'] = '1'
	try {
		await resolveStorageState(['member'], browser, dir)
	} finally {
		delete process.env['OPICE_AUTH_REFRESH']
	}
	expect(await readCalls()).toEqual([
		{ role: 'member', cachedPresent: false },
		{ role: 'member', cachedPresent: false },
	])
})

test('empty (logged-out) role → injects nothing and persists nothing', async () => {
	await writeProvider()
	expect(await resolveStorageState(['new-user'], browser, dir)).toBeNull()
	expect(await cacheJsonFiles()).toEqual([])
})

// A provider that differentiates roles, for the security-property tests below.
async function writeRichProvider(): Promise<void> {
	const cookie = (value: string) =>
		`{ cookies: [{ name: 'session', value: '${value}', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }`
	// Two roles whose localStorage lives on the SAME origin but under DISJOINT keys
	// — a legitimate union, not a conflict.
	const ls = (name: string, value: string) =>
		`{ cookies: [], origins: [{ origin: 'http://localhost', localStorage: [{ name: '${name}', value: '${value}' }] }] }`
	// An origin carrying Playwright's runtime-only `indexedDB` field (absent from
	// the public storageState() type) — how auth libraries like Firebase persist a
	// session. The merge must not drop it.
	const idb =
		`{ cookies: [], origins: [{ origin: 'http://localhost', localStorage: [{ name: 'fb_marker', value: '1' }], indexedDB: [{ name: 'firebaseLocalStorageDb', version: 1 }] }] }`
	const code = `
export async function authenticate(role, ctx) {
	if (role === 'label-only') return undefined         // not an auth role → annotation
	if (role === 'buyer') return ${cookie('buyer')}
	if (role === 'seller') return ${cookie('seller')}   // same cookie name, different value
	if (role === 'flags') return ${ls('feature_flags', '1')}
	if (role === 'tenant') return ${ls('tenant_ctx', 'acme')}  // same origin, different key
	if (role === 'idb') return ${idb}                   // origin carries indexedDB
	if (role === 'rotating') {
		// Refresh by MUTATING the cached object in place and returning the same ref.
		if (ctx.cached) { ctx.cached.cookies[0].value = 'v2'; return ctx.cached }
		return ${cookie('v1')}
	}
	return { cookies: [], origins: [] }
}
`
	await fs.writeFile(path.join(dir, 'browser-auth.js'), code)
}

// Run `fn`, capturing whatever it returns alongside everything it logged to
// console.warn (so a test can assert both the merged state and the warning).
async function withWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const warnings: string[] = []
	const original = console.warn
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
	try {
		const result = await fn()
		return { result, warnings }
	} finally {
		console.warn = original
	}
}

test('distinct roles that slug alike get separate cache files (no identity bleed)', async () => {
	await writeProvider()
	// 'admin' and 'admin!' both slug to 'admin' — the hash suffix must keep them apart.
	await resolveStorageState(['admin', 'admin!'], browser, dir)
	const files = await cacheJsonFiles()
	expect(files).toHaveLength(2)
	expect(new Set(files).size).toBe(2)
})

test('same role against different environments caches separately', async () => {
	await writeProvider()
	await resolveStorageState(['member'], browser, dir, 'https://stage.example.com')
	await resolveStorageState(['member'], browser, dir, 'http://localhost:3000')
	// Two distinct origins ⇒ two distinct cache files, so no cross-env session bleed.
	expect(await cacheJsonFiles()).toHaveLength(2)
})

test('conflicting same-name cookies across roles → warns loudly and keeps last (no silent drop, no hard fail)', async () => {
	await writeRichProvider()
	const { result: state, warnings } = await withWarnings(() => resolveStorageState(['buyer', 'seller'], browser, dir))
	// Doesn't throw (a benign rotating cookie mustn't fail the scenario); last role wins…
	expect(state?.cookies?.find(c => c.name === 'session')?.value).toBe('seller')
	// …but the clash is surfaced, not swallowed.
	expect(warnings.join('\n')).toMatch(/one identity/)
})

test('disjoint localStorage keys on the same origin union cleanly (no false conflict)', async () => {
	await writeRichProvider()
	const { result: state, warnings } = await withWarnings(() => resolveStorageState(['flags', 'tenant'], browser, dir))
	const origin = state?.origins?.find(o => o.origin === 'http://localhost')
	const keys = (origin?.localStorage ?? []).map(e => e.name).sort()
	expect(keys).toEqual(['feature_flags', 'tenant_ctx'])
	expect(warnings.join('\n')).toBe('') // no conflict — disjoint keys merge
})

test('merging an indexedDB-backed role with another role preserves the indexedDB data', async () => {
	await writeRichProvider()
	// 'idb' brings an IndexedDB-backed session on http://localhost; 'flags' brings
	// only localStorage on the same origin. The union must keep BOTH the merged
	// localStorage and the indexedDB field (a naive rebuild would drop the latter).
	const state = await resolveStorageState(['idb', 'flags'], browser, dir)
	const origin = state?.origins?.find(o => o.origin === 'http://localhost') as
		| (StorageState['origins'][number] & { indexedDB?: Array<{ name: string }> })
		| undefined
	expect((origin?.localStorage ?? []).map(e => e.name).sort()).toEqual(['fb_marker', 'feature_flags'])
	expect(origin?.indexedDB?.[0]?.name).toBe('firebaseLocalStorageDb')
})

test('OPICE_AUTH_STRICT=1 turns a genuine identity conflict into a hard failure', async () => {
	await writeRichProvider()
	process.env['OPICE_AUTH_STRICT'] = '1'
	try {
		await expect(resolveStorageState(['buyer', 'seller'], browser, dir)).rejects.toThrow(/one identity/)
	} finally {
		delete process.env['OPICE_AUTH_STRICT']
	}
})

test('a provider that refreshes by mutating the cached object persists the new session', async () => {
	await writeRichProvider()
	await resolveStorageState(['rotating'], browser, dir) // cold → persists v1
	expect((await readOnlyCache()).cookies?.[0]?.value).toBe('v1')
	await resolveStorageState(['rotating'], browser, dir) // warm → provider mutates cached → must persist v2
	expect((await readOnlyCache()).cookies?.[0]?.value).toBe('v2')
})

test('provider returning undefined → role treated as a pure annotation, skipped', async () => {
	await writeRichProvider()
	expect(await resolveStorageState(['label-only'], browser, dir)).toBeNull()
	expect(await cacheJsonFiles()).toEqual([])
})

test('persisted session is private (0600) and self-gitignored', async () => {
	await writeProvider()
	await resolveStorageState(['member'], browser, dir)
	const files = await cacheJsonFiles()
	expect(files).toHaveLength(1)
	// A local .gitignore that ignores everything keeps session tokens out of VCS.
	expect(await fs.readFile(path.join(authDir(), '.gitignore'), 'utf8')).toContain('*')
	if (process.platform !== 'win32') {
		const st = await fs.stat(path.join(authDir(), files[0]!))
		expect(st.mode & 0o777).toBe(0o600)
	}
})
