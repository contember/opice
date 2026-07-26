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
	'/_next/static/chunks/',
	'/.svelte-kit/',
]

/**
 * A hashed production chunk — `index-a1b2c3d4.js`, `main.4f2b91.css`, and Vite's
 * base64url-style `index-C9nUJBE7.js`. Matching hex alone let that last shape
 * through as if it were a source file, putting an unmatchable build artifact in
 * the index instead of reporting that source attribution had failed.
 */
const HASHED_CHUNK_RE = /[.-][A-Za-z0-9_-]{8,}\.(?:js|mjs|css)$/

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
	let pathname = url.pathname
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
	if (HASHED_CHUNK_RE.test(pathname)) {
		// A built bundle: its name says nothing about which sources went into it.
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

function toPosix(p: string): string {
	return p.split(path.sep).join('/')
}
