/**
 * Module URL → repo source path.
 *
 * The cheapest honest answer to "which files does this scenario touch" comes
 * from the network layer, for free: a dev server (Vite, and anything else
 * serving native ES modules) requests each module by its own path, so
 * `GET /src/components/InvoiceForm.tsx` *is* the source file. No coverage
 * instrumentation, no source maps, no overhead.
 *
 * Its limit is worth stating plainly: a requested module was **loaded**, not
 * necessarily **executed**. An import that only pulls in a type or a constant
 * counts the same as one whose component rendered. For impact analysis that
 * errs in the safe direction (a test too many), and V8 coverage — when
 * available — refines it. For a production bundle this yields nothing useful,
 * which is exactly when coverage + source maps take over.
 *
 * Paths are reported as observed rather than resolved against the repo, because
 * the dev server's root and the repo root often differ (a monorepo app at
 * `apps/web` serves `/src/App.tsx`). Matching against a `git diff` list is
 * suffix-tolerant on the platform side for precisely this reason — the same
 * trick `select.ts` uses for test-file selection.
 */

import path from 'node:path'

/** Extensions that count as project source. Styles are included — a changed stylesheet is a real change. */
const SOURCE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
	'.vue', '.svelte', '.astro',
	'.css', '.scss', '.sass', '.less', '.styl',
])

/**
 * Path fragments that mark a URL as tooling or vendor code rather than project
 * source: the dev client, HMR runtimes, pre-bundled dependencies.
 */
const VENDOR_FRAGMENTS = [
	'/@vite/',
	'/@react-refresh',
	'/@id/',
	'/node_modules/',
	'/.vite/',
	'/__vite',
	'/.nuxt/',
	'/.svelte-kit/',
]

/**
 * Framework BUILD OUTPUT holding the application's own code, compiled.
 *
 * The distinction from {@link VENDOR_FRAGMENTS} is what the silence means. A
 * `/node_modules/` request is noise: skipping it costs nothing, because it was
 * never project source. A Next.js chunk is the opposite — it IS the project's
 * source, compiled beyond recognition, so passing over it quietly would let the
 * footprint report a complete and empty file set for a whole production app and
 * replace real source edges with nothing. It has to read as "could not tell".
 */
const BUNDLE_FRAGMENTS = [
	'/_next/static/chunks/',
]

/**
 * A hashed production chunk — `index-a1b2c3d4.js`, `main.4f2b91.css`, and Vite's
 * base64url-style `index-C9nUJBE7.js`. Matching hex alone let that last shape
 * through as if it were a source file, putting an unmatchable build artifact in
 * the index instead of reporting that source attribution had failed.
 */
const HASHED_CHUNK_RE = /[.-]([A-Za-z0-9_-]{8,})\.(?:js|mjs|css)$/

/**
 * Does this suffix actually look like a build hash, rather than a long word?
 *
 * Length alone said yes to `admin-dashboard.css`, which cost that stylesheet its
 * file edge entirely — changing it could then select nothing. A real hash is
 * either pure hex or mixes digits with both letter cases; an English compound
 * does neither.
 */
function looksHashed(token: string): boolean {
	if (/^[0-9a-f]{8,}$/i.test(token)) return true
	return /\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token)
}

/**
 * Directories that hold BUILD OUTPUT rather than source. A `.js` or `.css`
 * served directly out of one of these is an artifact whatever its name, and its
 * sources are only recoverable through a source map.
 *
 * Deliberately shallow: only the file's own directory chain from the root is
 * considered, so a genuine source file at `src/assets/icons.ts` is untouched —
 * it is the leading segment that says "this came out of a bundler".
 */
const BUILD_OUTPUT_DIRS = new Set(['assets', 'static', 'dist', 'build', 'out', '_next', '_nuxt', '_astro', '_app', 'bundles'])

/**
 * Directories that hold build output in SOME projects and hand-written source in
 * others. `/js/app.js` is a bundle; `/js/cart-utils.js` is very plausibly a
 * source file in a plain-JS project. The directory alone cannot decide, so these
 * are only treated as output when the FILENAME also looks like a bundle.
 */
const AMBIGUOUS_OUTPUT_DIRS = new Set(['js', 'css', 'scripts', 'styles'])

/** Names a bundler produces: `app.js`, `main.css`, `vendor-2.js`, `runtime.mjs`. */
const BUNDLE_NAME_RE = /^(?:bundle|main|app|index|vendor|runtime|polyfills|chunk|common)(?:[.-][A-Za-z0-9_-]+)*\.(?:js|mjs|css)$/i

function isBuildOutput(pathname: string): boolean {
	const extension = path.posix.extname(pathname).toLowerCase()
	// Only ever true for BUILT extensions — a `.tsx` in any directory is source.
	if (extension !== '.js' && extension !== '.mjs' && extension !== '.css') return false
	const segments = pathname.split('/').filter(Boolean)
	const basename = segments[segments.length - 1] ?? ''
	// A bundle-shaped name at the root has no directory to go on and needs none.
	if (segments.length === 1) return BUNDLE_NAME_RE.test(basename)
	const leading = (segments[0] ?? '').toLowerCase()
	// The first segment only: `/assets/app.js` is output, `src/assets/icons.js` is not.
	if (BUILD_OUTPUT_DIRS.has(leading)) return true
	// Both signals required, since neither is conclusive alone.
	return AMBIGUOUS_OUTPUT_DIRS.has(leading) && BUNDLE_NAME_RE.test(basename)
}

export interface ModulePathResult {
	/** The repo-relative-ish source path, or null when this URL isn't project source. */
	path: string | null
	/**
	 * True when the URL looked like a bundled production chunk. The collector
	 * uses this to warn once that file-level footprint needs a dev server or
	 * source maps — silence here would read as "this scenario touches no files".
	 */
	bundled: boolean
}

/**
 * Map a same-origin script/style URL to a source path.
 *
 * `sourceRoot` is prepended when set (for a dev server rooted below the repo
 * root). Returns `{ path: null }` for anything that isn't project source.
 */
export function moduleUrlToSourcePath(rawUrl: string, sourceRoot?: string): ModulePathResult {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		return { path: null, bundled: false }
	}
	// Decoded: a source file with a space or a non-ASCII name arrives
	// percent-encoded (`/src/My%20Panel.tsx`), while git reports it decoded, so an
	// encoded path would match nothing. Decoding is per segment so an encoded
	// separator can't invent a directory level.
	let pathname = decodePathname(url.pathname)
	if (BUNDLE_FRAGMENTS.some((fragment) => pathname.includes(fragment))) {
		return { path: null, bundled: true }
	}
	if (VENDOR_FRAGMENTS.some((fragment) => pathname.includes(fragment))) {
		return { path: null, bundled: false }
	}
	// Vite serves files outside its root through `/@fs/<absolute path>` — that's a
	// monorepo sibling package, which is very much project source.
	let absolute = false
	if (pathname.startsWith('/@fs/')) {
		pathname = pathname.slice('/@fs'.length)
		absolute = true
	}
	const extension = path.posix.extname(pathname).toLowerCase()
	if (!SOURCE_EXTENSIONS.has(extension)) {
		return { path: null, bundled: false }
	}
	const hashed = HASHED_CHUNK_RE.exec(pathname)
	if (hashed && looksHashed(hashed[1] as string)) {
		// A built bundle: its name says nothing about which sources went into it.
		return { path: null, bundled: true }
	}
	if (isBuildOutput(pathname)) {
		// Not every bundle is hashed — `/assets/app.js`, `/bundle.js`,
		// `/static/js/main.js` are ordinary production output. Recording those as
		// source paths is worse than recording nothing: the file dimension would
		// then claim to be complete while holding a single bundle filename, and
		// replace the real source edges with it, after which no source change
		// selects the scenario again. Directory is the signal — a dev server
		// serves the source TREE (`/src/components/Cart.tsx`), a build serves a
		// handful of artifacts out of its output directory.
		return { path: null, bundled: true }
	}
	if (absolute) {
		// Relativize against the working directory when the file is inside it;
		// otherwise keep the absolute path (suffix matching still finds it).
		const relative = path.relative(process.cwd(), pathname)
		return { path: relative.startsWith('..') ? pathname : toPosix(relative), bundled: false }
	}
	const trimmed = pathname.replace(/^\/+/, '')
	if (!trimmed) return { path: null, bundled: false }
	return { path: sourceRoot ? toPosix(path.posix.join(sourceRoot, trimmed)) : trimmed, bundled: false }
}

/**
 * Normalize a source path coming out of a source map: strip webpack/rollup
 * scheme prefixes, drop `./`, and relativize an absolute path against the
 * working directory when it lives inside it.
 */
export function normalizeSourceMapPath(source: string, sourceRoot?: string): string | null {
	let s = source.trim()
	if (!s) return null
	// `webpack://name/./src/App.tsx`, `rollup:///src/App.tsx`, `vite:///src/App.tsx`
	const scheme = /^[a-z-]+:\/\/(?:[^/]*)?\//i.exec(s)
	if (scheme) s = s.slice(scheme[0].length)
	s = toPosix(s)
	while (s.startsWith('./')) s = s.slice(2)
	if (s.startsWith('/')) {
		const relative = path.relative(process.cwd(), s)
		if (!relative.startsWith('..')) return toPosix(relative)
		return s
	}
	if (s.includes('node_modules/')) return null
	const extension = path.posix.extname(s).toLowerCase()
	if (extension && !SOURCE_EXTENSIONS.has(extension)) return null
	return sourceRoot ? toPosix(path.posix.join(sourceRoot, s)) : s
}

/** Percent-decode each path segment, leaving the separators alone. */
function decodePathname(pathname: string): string {
	return pathname
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment).replace(/\//g, '%2F')
			} catch {
				return segment
			}
		})
		.join('/')
}

function toPosix(p: string): string {
	return p.split(path.sep).join('/')
}
