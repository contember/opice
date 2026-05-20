/**
 * `opice install-skills [--global] [--ref=<branch>]` — install opice's Claude
 * Code extensions into a project (or `~/.claude` with --global).
 *
 *   skills/*  → <target>/.claude/skills/*
 *   agents/*  → <target>/.claude/agents/*
 *
 * Files are pulled from the public GitHub repo (no auth, no publish needed),
 * so a freshly-onboarded project can `bunx opice install-skills` and pick up
 * opice-author / opice-plan / opice-batch / opice-reeval + the author agent.
 *
 * Project-local is the default so the extensions can be committed and shared
 * with the team; restart Claude Code afterwards to load them.
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const REPO = 'contember/opice'

interface TreeEntry {
	path: string
	type: string
}

export async function installSkillsCommand(args: string[]): Promise<number> {
	const global = args.includes('--global')
	const ref = args.find((a) => a.startsWith('--ref='))?.slice('--ref='.length) ?? process.env['OPICE_SKILLS_REF'] ?? 'main'
	const base = path.join(global ? homedir() : process.cwd(), '.claude')

	const headers = { 'user-agent': 'opice-cli', accept: 'application/vnd.github+json' }
	let tree: TreeEntry[]
	try {
		const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${ref}?recursive=1`, { headers })
		if (!res.ok) {
			console.error(`[opice] could not list ${REPO}@${ref}: ${res.status} ${res.statusText}`)
			return 1
		}
		tree = ((await res.json()) as { tree?: TreeEntry[] }).tree ?? []
	} catch (err) {
		console.error(`[opice] request failed: ${(err as Error).message}`)
		return 1
	}

	const files = tree.filter(
		(t) => t.type === 'blob' && (t.path.startsWith('skills/') || (t.path.startsWith('agents/') && t.path.endsWith('.md'))),
	)
	if (files.length === 0) {
		console.error(`[opice] no skills/agents found in ${REPO}@${ref}`)
		return 1
	}

	let written = 0
	for (const file of files) {
		try {
			const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${file.path}`, {
				headers: { 'user-agent': 'opice-cli' },
			})
			if (!res.ok) {
				console.error(`[opice] skip ${file.path}: ${res.status}`)
				continue
			}
			const body = Buffer.from(await res.arrayBuffer())
			const dst = path.join(base, file.path) // file.path is already `skills/…` / `agents/…`
			await fs.mkdir(path.dirname(dst), { recursive: true })
			await fs.writeFile(dst, body)
			written++
		} catch (err) {
			console.error(`[opice] skip ${file.path}: ${(err as Error).message}`)
		}
	}

	const skillNames = new Set(files.filter((f) => f.path.startsWith('skills/')).map((f) => f.path.split('/')[1]))
	console.log(`✓ Installed ${written} file(s) into ${base}`)
	console.log(`  skills: ${[...skillNames].join(', ') || '—'}`)
	console.log('  Restart Claude Code to load the extensions.')
	return 0
}
