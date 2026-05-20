#!/usr/bin/env bun
/**
 * Install opice's Claude Code extensions into `~/.claude` as symlinks, so
 * edits in this repo are reflected immediately without a copy step:
 *   - every skill in `opice/skills/*`  → `~/.claude/skills/`
 *   - every agent in `opice/agents/*.md` → `~/.claude/agents/`
 *
 * Usage:
 *   bun run scripts/install-skills.ts            # symlink (default)
 *   bun run scripts/install-skills.ts --copy     # copy instead of symlink
 *   bun run scripts/install-skills.ts --uninstall  # remove symlinks
 *
 * Idempotent — running again replaces broken/stale links.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SKILLS_DIR = join(ROOT, 'skills')
const AGENTS_DIR = join(ROOT, 'agents')
const CLAUDE_DIR = join(homedir(), '.claude')

const args = process.argv.slice(2)
const useCopy = args.includes('--copy')
const uninstall = args.includes('--uninstall')

function install(name: string, src: string, targetDir: string, kind: 'dir' | 'file'): void {
	mkdirSync(targetDir, { recursive: true })
	const dst = join(targetDir, name)

	if (existsSync(dst) || lstatSync(dst, { throwIfNoEntry: false })) {
		const stat = lstatSync(dst)
		if (stat.isSymbolicLink() || uninstall) {
			rmSync(dst, { recursive: true, force: true })
		} else {
			console.warn(`SKIP ${name}: ${dst} exists and is not a symlink — remove it manually first`)
			return
		}
	}

	if (uninstall) {
		console.log(`removed ${dst}`)
		return
	}

	if (useCopy) {
		cpSync(src, dst, { recursive: true })
		console.log(`copied  ${name} → ${dst}`)
	} else {
		symlinkSync(src, dst, kind === 'dir' ? 'dir' : 'file')
		console.log(`linked  ${name} → ${dst}`)
	}
}

let installed = 0

if (existsSync(SKILLS_DIR)) {
	for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		install(entry.name, join(SKILLS_DIR, entry.name), join(CLAUDE_DIR, 'skills'), 'dir')
		installed++
	}
}

if (existsSync(AGENTS_DIR)) {
	for (const entry of readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) continue
		install(entry.name, join(AGENTS_DIR, entry.name), join(CLAUDE_DIR, 'agents'), 'file')
		installed++
	}
}

if (installed === 0) {
	console.log('Nothing found to install (no skills/ or agents/ entries).')
	process.exit(0)
}

console.log(uninstall ? 'Done — extensions removed.' : 'Done — restart Claude Code to load the extensions.')
