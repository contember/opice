#!/usr/bin/env bun
/**
 * Install every skill in `opice/skills/*` into `~/.claude/skills/` as a
 * symlink, so edits in this repo are reflected immediately in Claude
 * Code without a copy step.
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

const SKILLS_DIR = resolve(import.meta.dir, '..', 'skills')
const TARGET_DIR = join(homedir(), '.claude', 'skills')

const args = process.argv.slice(2)
const useCopy = args.includes('--copy')
const uninstall = args.includes('--uninstall')

if (!existsSync(SKILLS_DIR)) {
	console.error(`No skills directory at ${SKILLS_DIR}`)
	process.exit(1)
}

mkdirSync(TARGET_DIR, { recursive: true })

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name)

if (skills.length === 0) {
	console.log('No skills found in', SKILLS_DIR)
	process.exit(0)
}

for (const skill of skills) {
	const src = join(SKILLS_DIR, skill)
	const dst = join(TARGET_DIR, skill)

	if (existsSync(dst) || lstatSync(dst, { throwIfNoEntry: false })) {
		const stat = lstatSync(dst)
		if (stat.isSymbolicLink() || uninstall) {
			rmSync(dst, { recursive: true, force: true })
		} else {
			console.warn(`SKIP ${skill}: ${dst} exists and is not a symlink — remove it manually first`)
			continue
		}
	}

	if (uninstall) {
		console.log(`removed ${dst}`)
		continue
	}

	if (useCopy) {
		cpSync(src, dst, { recursive: true })
		console.log(`copied  ${skill} → ${dst}`)
	} else {
		symlinkSync(src, dst, 'dir')
		console.log(`linked  ${skill} → ${dst}`)
	}
}

console.log(uninstall ? 'Done — skills removed.' : 'Done — restart Claude Code to load the skills.')
