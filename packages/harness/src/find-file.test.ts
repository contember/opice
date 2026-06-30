import { afterEach, beforeEach, expect, test } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findUserFile } from './find-file.js'

// Build a tree:  <root>/browser-tools.js           (a STRAY file ABOVE the project,
//                                                    in a direct ancestor of `sub`)
//                <root>/proj/package.json           (the project root — no .git)
//                <root>/proj/browser-tools.js        (the legit file, at the root)
//                <root>/proj/sub/                     (where "tests run from")
// `root` is itself under the OS tmp dir, which has no package.json/.git up to
// home, so the project ceiling is deterministically `<root>/proj`.
let root: string
let proj: string
let sub: string
let stray: string
const NAMES = ['browser-tools.ts', 'browser-tools.js', 'browser-tools.mjs']

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), 'opice-find-test-'))
	proj = path.join(root, 'proj')
	sub = path.join(proj, 'sub')
	stray = path.join(root, 'browser-tools.js')
	await fs.mkdir(sub, { recursive: true })
	await fs.writeFile(path.join(proj, 'package.json'), '{}')
	await fs.writeFile(stray, '// stray — above the project root, must not be resolved')
})
afterEach(async () => {
	delete process.env['OPICE_PROJECT_ROOT']
	await fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

test('finds a file at the project root (package.json) from a subdirectory', async () => {
	const legit = path.join(proj, 'browser-tools.js')
	await fs.writeFile(legit, '// legit')
	expect(findUserFile(NAMES, sub)).toBe(legit)
})

test('never resolves a file ABOVE the project root (security boundary)', async () => {
	// No file inside proj — only the stray one in <root>/outside, above the ceiling.
	expect(findUserFile(NAMES, sub)).toBeNull()
})

test('a .git directory is the ceiling even without package.json', async () => {
	const gitProj = path.join(root, 'git-proj')
	await fs.mkdir(path.join(gitProj, '.git'), { recursive: true })
	await fs.mkdir(path.join(gitProj, 'nested'), { recursive: true })
	const legit = path.join(gitProj, 'browser-tools.js')
	await fs.writeFile(legit, '// legit')
	expect(findUserFile(NAMES, path.join(gitProj, 'nested'))).toBe(legit)
	// …and a file above the .git root is still out of reach.
	await fs.rm(legit)
	expect(findUserFile(NAMES, path.join(gitProj, 'nested'))).toBeNull()
})

test('OPICE_PROJECT_ROOT widens the ceiling to a real project root above the nearest one', async () => {
	// <root> is itself a project root (a monorepo root, say) carrying the shared file.
	await fs.writeFile(path.join(root, 'package.json'), '{}')
	// Default: the nearest marker (<proj>) bounds the search, so the file is out of reach.
	expect(findUserFile(NAMES, sub)).toBeNull()
	// Override to the monorepo root (which holds a marker) raises the ceiling to it.
	process.env['OPICE_PROJECT_ROOT'] = root
	expect(findUserFile(NAMES, sub)).toBe(stray)
})

test('OPICE_PROJECT_ROOT pointed at a markerless shared parent is ignored', async () => {
	// <root> has NO .git/package.json (a bare shared dir), so it can't be used to
	// widen the search into it — the override is rejected and auto (<proj>) applies.
	process.env['OPICE_PROJECT_ROOT'] = root
	expect(findUserFile(NAMES, sub)).toBeNull()
})

test('stops at the NEAREST project marker, not a higher one (a package.json above the project)', async () => {
	// <root> also has a package.json + a stray file — the topmost marker. The ceiling
	// must still be <proj> (the nearest), so the higher stray is never resolved.
	await fs.writeFile(path.join(root, 'package.json'), '{}')
	expect(findUserFile(NAMES, sub)).toBeNull()
})

test('ignores OPICE_PROJECT_ROOT when it is not an ancestor of `from` (no walk to /)', async () => {
	// A descendant (or unrelated) override must NOT leave the walk unbounded — it
	// falls back to the auto ceiling (<proj>), so the stray above proj stays unreachable.
	await fs.mkdir(path.join(sub, 'deeper'), { recursive: true })
	process.env['OPICE_PROJECT_ROOT'] = path.join(sub, 'deeper') // strictly below `sub`
	expect(findUserFile(NAMES, sub)).toBeNull()
})

test('ignores OPICE_PROJECT_ROOT="/" (an unsafe ceiling) and falls back to auto', async () => {
	process.env['OPICE_PROJECT_ROOT'] = path.parse(root).root // the filesystem root
	expect(findUserFile(NAMES, sub)).toBeNull() // stray above proj still unreachable
})

test('a nearer package.json bounds the search even when a .git sits higher up', async () => {
	// <gitRoot>/.git + a stray <gitRoot>/browser-tools.js, with the actual project a
	// markerless-of-.git subdir that has its OWN package.json (extracted tarball /
	// vendored copy). The nearest marker (the subpackage) must bound the search so
	// the stray at the higher .git dir is never imported.
	const gitRoot = path.join(root, 'mono')
	const pkg = path.join(gitRoot, 'clientproj')
	await fs.mkdir(path.join(gitRoot, '.git'), { recursive: true })
	await fs.mkdir(path.join(pkg, 'src'), { recursive: true })
	await fs.writeFile(path.join(pkg, 'package.json'), '{}')
	await fs.writeFile(path.join(gitRoot, 'browser-tools.js'), '// stray at the higher .git dir')
	expect(findUserFile(NAMES, path.join(pkg, 'src'))).toBeNull()
})

test('isAncestorOrSelf honours an override whose path segment merely starts with ".."', async () => {
	// A real ancestor under a dir named like `..cache` must still be accepted.
	const weird = path.join(root, '..cache', 'proj')
	const weirdSub = path.join(weird, 'sub')
	await fs.mkdir(weirdSub, { recursive: true })
	await fs.writeFile(path.join(weird, 'package.json'), '{}')
	const file = path.join(weird, 'browser-tools.js')
	await fs.writeFile(file, '// at the override root')
	process.env['OPICE_PROJECT_ROOT'] = weird
	expect(findUserFile(NAMES, weirdSub)).toBe(file)
})
