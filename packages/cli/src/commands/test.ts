import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config'
import { detectGitMeta } from '../git'

const HANDOFF_DIR = path.join(tmpdir(), 'opice-handoffs')

interface Handoff {
	endpoint: string
	apiKey: string
	runId: string
}

export async function testCommand(args: string[]): Promise<number> {
	const config = await loadConfig()
	const project = process.env['OPICE_PROJECT'] ?? config?.project
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint
	const apiKey = process.env['OPICE_API_KEY']

	if (!project) {
		warn('OPICE_PROJECT not set and no opice.config.json found. Run `opice init` or set the env var.')
	}
	if (!endpoint) {
		warn('OPICE_ENDPOINT not set and no opice.config.json found. Tests will run without reporting.')
	}
	if (!apiKey) {
		warn('OPICE_API_KEY not set. Tests will run without reporting.')
	}

	const git = detectGitMeta()
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(project ? { OPICE_PROJECT: project } : {}),
		...(endpoint ? { OPICE_ENDPOINT: endpoint } : {}),
		...(git.branch ? { OPICE_BRANCH: git.branch } : {}),
		...(git.commit ? { OPICE_COMMIT: git.commit } : {}),
	}

	// Always invoke `bun test`; any user-passed args go after.
	const child = spawn('bun', ['test', ...args], { stdio: 'inherit', env })

	const exitCode = await new Promise<number>((resolve) => {
		child.on('exit', (code) => resolve(code ?? 1))
	})

	// After bun test exits, look for handoff files the reporter wrote and
	// POST /finish for each run so it leaves "running" state.
	await finalizeHandoffs(child.pid, project, process.env['OPICE_READ_TOKEN'])

	return exitCode
}

async function finalizeHandoffs(childPid: number | undefined, slug: string | undefined, readToken: string | undefined): Promise<void> {
	let files: string[]
	try {
		files = await fs.readdir(HANDOFF_DIR)
	} catch {
		return // no handoff dir → no runs reported, nothing to finalize
	}
	const matching = childPid ? files.filter((f) => f === `${childPid}.json`) : files
	for (const file of matching) {
		const full = path.join(HANDOFF_DIR, file)
		try {
			const handoff = JSON.parse(await fs.readFile(full, 'utf-8')) as Handoff
			await finishRun(handoff)
			printRunUrl(handoff, slug, readToken)
		} catch (err) {
			warn(`Failed to finalize run from ${file}: ${(err as Error).message}`)
		} finally {
			await fs.unlink(full).catch(() => {})
		}
	}
}

function printRunUrl(handoff: Handoff, slug: string | undefined, readToken: string | undefined): void {
	if (!slug) return
	const query = readToken ? `?token=${readToken}` : ''
	const url = `${handoff.endpoint}/p/${slug}/r/${handoff.runId}${query}`
	console.error(`[opice] View run: ${url}`)
	if (!readToken) {
		console.error('[opice] (open the dashboard for the tokened read-only link, or set OPICE_READ_TOKEN to embed it here)')
	}
}

async function finishRun(handoff: Handoff): Promise<void> {
	const url = `${handoff.endpoint}/api/v1/runs/${handoff.runId}/finish`
	const response = await fetch(url, {
		method: 'POST',
		headers: { authorization: `Bearer ${handoff.apiKey}` },
	})
	if (!response.ok) {
		throw new Error(`${response.status} ${await response.text()}`)
	}
}

function warn(message: string): void {
	console.error(`[opice] warning: ${message}`)
}
