import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config'
import { parseOpiceDsn } from '../dsn'
import { detectGitMeta } from '../git'

const HANDOFF_DIR = path.join(tmpdir(), 'opice-handoffs')

interface Handoff {
	endpoint: string
	/** Project slug — used to build the /api/v1/<project>/runs/<id>/finish URL. */
	project: string
	/** Service-token credentials for the CF-Access-Client-* headers on POST /finish. */
	clientId: string
	clientSecret: string
	runId: string
}

export async function testCommand(args: string[]): Promise<number> {
	const config = await loadConfig()
	const dsn = parseOpiceDsn(process.env['OPICE_DSN'])
	const project = process.env['OPICE_PROJECT'] ?? config?.project ?? dsn?.project
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint ?? dsn?.endpoint
	const clientId = process.env['OPICE_CLIENT_ID'] ?? dsn?.clientId
	const clientSecret = process.env['OPICE_CLIENT_SECRET'] ?? dsn?.clientSecret

	if (!project) {
		warn('OPICE_PROJECT not set and no opice.config.json found. Run `opice init` or set the env var.')
	}
	if (!endpoint) {
		warn('OPICE_ENDPOINT not set and no opice.config.json found. Tests will run without reporting.')
	}
	if (!clientId || !clientSecret) {
		warn('OPICE_CLIENT_ID / OPICE_CLIENT_SECRET not set (the OPICE_DSN userinfo). Tests will run without reporting.')
	}

	// `--tier=NAME` selects which test tier runs (critical < standard < extended).
	// CLI flag wins over OPICE_TIER, which wins over opice.config.json's `tier`.
	// The harness reads OPICE_TIER and skips (and reports as `skipped`) any
	// scenario above the selected tier.
	const { tier, rest: afterTier } = extractTier(args)
	const resolvedTier = tier ?? process.env['OPICE_TIER'] ?? config?.tier

	const git = detectGitMeta()
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(project ? { OPICE_PROJECT: project } : {}),
		...(endpoint ? { OPICE_ENDPOINT: endpoint } : {}),
		// Resolve the service-token pair (incl. from a DSN) into the explicit vars the
		// harness reporter reads, so a bare OPICE_DSN is enough to report.
		...(clientId ? { OPICE_CLIENT_ID: clientId } : {}),
		...(clientSecret ? { OPICE_CLIENT_SECRET: clientSecret } : {}),
		...(git.branch ? { OPICE_BRANCH: git.branch } : {}),
		...(git.commit ? { OPICE_COMMIT: git.commit } : {}),
		...(resolvedTier ? { OPICE_TIER: resolvedTier } : {}),
	}

	// `--retries=N` (opice's spelling) → bun's `--retry=N`, the global default
	// retry budget for every scenario. CLI flag wins over opice.config.json's
	// `retries`. A per-scenario `walkthrough`/meta `retries` overrides both.
	const { retries, rest } = extractRetries(afterTier)
	const resolvedRetries = retries ?? config?.retries
	const bunArgs = ['test', ...rest]
	// Don't clobber an explicit `--retry` the caller passed through to bun.
	if (resolvedRetries !== undefined && !rest.some((a) => a === '--retry' || a.startsWith('--retry='))) {
		bunArgs.push(`--retry=${resolvedRetries}`)
	}

	const child = spawn('bun', bunArgs, { stdio: 'inherit', env })

	const exitCode = await new Promise<number>((resolve) => {
		child.on('exit', (code) => resolve(code ?? 1))
	})

	// After bun test exits, look for handoff files the reporter wrote and
	// POST /finish for each run so it leaves "running" state.
	await finalizeHandoffs(child.pid, project)

	return exitCode
}

/**
 * Pull opice's `--retries=N` / `--retries N` out of the arg list (so it isn't
 * forwarded to bun, which only knows `--retry`). Returns the parsed budget and
 * the remaining args. An invalid value is ignored (falls through to config).
 */
function extractRetries(args: string[]): { retries: number | undefined; rest: string[] } {
	const rest: string[] = []
	let retries: number | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith('--retries=')) {
			const n = Number(arg.slice('--retries='.length))
			if (Number.isInteger(n) && n >= 0) retries = n
		} else if (arg === '--retries') {
			const n = Number(args[i + 1])
			if (Number.isInteger(n) && n >= 0) {
				retries = n
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	return { retries, rest }
}

/**
 * Pull opice's `--tier=NAME` / `--tier NAME` out of the arg list (it's an opice
 * concept, not a bun flag) and return the selected tier plus the remaining args.
 * The value is passed straight through to the harness via OPICE_TIER, which
 * validates it — so an unrecognized value isn't rejected here.
 */
function extractTier(args: string[]): { tier: string | undefined; rest: string[] } {
	const rest: string[] = []
	let tier: string | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith('--tier=')) {
			tier = arg.slice('--tier='.length)
		} else if (arg === '--tier') {
			const next = args[i + 1]
			if (next !== undefined) {
				tier = next
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	return { tier, rest }
}

async function finalizeHandoffs(childPid: number | undefined, slug: string | undefined): Promise<void> {
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
			printRunUrl(handoff, slug)
		} catch (err) {
			warn(`Failed to finalize run from ${file}: ${(err as Error).message}`)
		} finally {
			await fs.unlink(full).catch(() => {})
		}
	}
}

function printRunUrl(handoff: Handoff, slug: string | undefined): void {
	if (!slug) return
	const url = `${handoff.endpoint}/p/${slug}/r/${handoff.runId}`
	console.error(`[opice] View run: ${url}`)
	console.error('[opice] (sign in to view, or create a read-only share link from the run page)')
}

async function finishRun(handoff: Handoff): Promise<void> {
	const url = `${handoff.endpoint}/api/v1/${handoff.project}/runs/${handoff.runId}/finish`
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'cf-access-client-id': handoff.clientId,
			'cf-access-client-secret': handoff.clientSecret,
		},
	})
	if (!response.ok) {
		throw new Error(`${response.status} ${await response.text()}`)
	}
}

function warn(message: string): void {
	console.error(`[opice] warning: ${message}`)
}
