/**
 * Listing a directory tree, for plugins that resolve a dependency against files
 * that actually exist.
 *
 * Both built-in resolvers are built on a listing rather than on a naming
 * heuristic, which is what keeps them honest: they can only ever claim a path
 * the repo really has, so a wrong guess produces no dependency instead of a
 * phantom one.
 */

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface ListOptions {
	/** Keep only these extensions (with the dot). Everything, when omitted. */
	extensions?: string[]
	/** Directory names never descended into. */
	skip?: string[]
}

const DEFAULT_SKIP = ['node_modules', 'dist', '.git']

/**
 * Every file under `dir`, as `/`-separated paths relative to nothing — they keep
 * whatever shape `dir` had, so a repo-relative `dir` yields repo-relative
 * results, which is what the impact query matches against.
 *
 * Never throws: a directory that doesn't exist is an empty listing, because a
 * plugin misconfiguration must not be able to fail a test.
 */
export function listFiles(dir: string, options: ListOptions = {}): Set<string> {
	const skip = new Set(options.skip ?? DEFAULT_SKIP)
	const out = new Set<string>()
	const walk = (current: string): void => {
		let entries: string[]
		try {
			entries = readdirSync(current)
		} catch {
			return
		}
		for (const entry of entries) {
			if (skip.has(entry)) continue
			const full = path.join(current, entry)
			let isDirectory: boolean
			try {
				isDirectory = statSync(full).isDirectory()
			} catch {
				continue
			}
			if (isDirectory) {
				walk(full)
				continue
			}
			if (options.extensions && !options.extensions.some((extension) => entry.endsWith(extension))) continue
			out.add(full.split(path.sep).join('/'))
		}
	}
	walk(dir)
	return out
}
