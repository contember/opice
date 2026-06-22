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

	// `--fail-on-report-error` turns a swallowed reporting failure into a non-zero
	// exit (default is best-effort: reporting never reddens CI). CLI flag wins over
	// OPICE_REPORT_STRICT, which wins over opice.config.json's `failOnReportError`.
	// We propagate it to the harness via OPICE_REPORT_STRICT (it fails the run from
	// a scenario's afterAll) AND honour it here for the POST /finish finalize.
	const { strict: strictFlag, rest: afterStrict } = extractStrict(afterTier)
	const strict = strictFlag || isTruthy(process.env['OPICE_REPORT_STRICT']) || config?.failOnReportError === true

	// `--report [file]` → a local HTML report (no platform creds). The harness
	// reporter reads OPICE_REPORT_FILE; the flag is the friendly door.
	const { reportFile: reportFlag, rest: afterReport } = extractReport(afterStrict)
	const reportFile = reportFlag ?? process.env['OPICE_REPORT_FILE']
	// `bun test` runs one process per file; give them a fresh shared dir to
	// aggregate into so a multi-file run yields one complete report (the harness
	// FileReporter reads OPICE_REPORT_PARTS_DIR). Unique per run ⇒ no stale parts.
	const reportPartsDir = reportFile ? await fs.mkdtemp(path.join(tmpdir(), 'opice-report-')) : undefined
	// Clear last run's screenshots. The FileReporter writes them beside the report
	// as `<report>-assets/` (name kept in sync with @opice/harness's assetsDirName)
	// so a deleted test's old screens don't linger in the new report.
	if (reportFile) {
		const assetsDir = path.join(path.dirname(reportFile), path.basename(reportFile).replace(/\.[^.]*$/, '') + '-assets')
		await fs.rm(assetsDir, { recursive: true, force: true }).catch(() => {})
	}

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
		...(strict ? { OPICE_REPORT_STRICT: '1' } : {}),
		...(reportFile ? { OPICE_REPORT_FILE: reportFile } : {}),
		...(reportPartsDir ? { OPICE_REPORT_PARTS_DIR: reportPartsDir } : {}),
	}

	// `--retries=N` (opice's spelling) → bun's `--retry=N`, the global default
	// retry budget for every scenario. CLI flag wins over opice.config.json's
	// `retries`. A per-scenario `walkthrough`/meta `retries` overrides both.
	const { retries, rest } = extractRetries(afterReport)
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

	if (reportFile) {
		console.log(`[opice] report: ${path.resolve(reportFile)}`)
	}
	// The report is fully written (the harness aggregates on every render); the
	// parts dir is just scratch — clean it up.
	if (reportPartsDir) {
		await fs.rm(reportPartsDir, { recursive: true, force: true }).catch(() => {})
	}

	// After bun test exits, look for handoff files the reporter wrote and
	// POST /finish for each run so it leaves "running" state.
	const finalizeFailed = await finalizeHandoffs(child.pid, project)

	// Under strict reporting, a failed finalize (POST /finish) reddens an
	// otherwise-green run — the same contract the harness enforces for in-test
	// reports. Don't mask a real test failure: only escalate when bun itself was
	// green. (An in-test report failure already failed bun via the harness.)
	if (exitCode === 0 && strict && finalizeFailed) {
		warn('reporting failed and --fail-on-report-error is set — exiting non-zero.')
		return 1
	}

	return exitCode
}

/**
 * Pull opice's `--retries=N` / `--retries N` out of the arg list (so it isn't
 * forwarded to bun, which only knows `--retry`). Returns the parsed budget and
 * the remaining args. An invalid value is ignored (falls through to config).
 */
/**
 * Pull opice's `--report [file]` out of the arg list (it's not a bun flag). The
 * value is optional — a bare `--report` defaults to `.opice/report.html`. To
 * avoid swallowing a bun test-file argument (`opice test --report foo.test.ts`),
 * a following token is only taken as the path when it *looks* like one (ends in
 * `.html`/`.htm`); otherwise use the explicit `--report=<file>` form. Returns
 * the resolved file (or undefined when absent) and the remaining args.
 */
const DEFAULT_REPORT_FILE = '.opice/report.html'
function looksLikeReportPath(s: string): boolean {
	return /\.html?$/i.test(s)
}
function extractReport(args: string[]): { reportFile: string | undefined; rest: string[] } {
	const rest: string[] = []
	let reportFile: string | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith('--report=')) {
			reportFile = arg.slice('--report='.length) || DEFAULT_REPORT_FILE
		} else if (arg === '--report') {
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith('-') && looksLikeReportPath(next)) {
				reportFile = next
				i++ // consume the value
			} else {
				reportFile = DEFAULT_REPORT_FILE
			}
		} else {
			rest.push(arg)
		}
	}
	return { reportFile, rest }
}

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

/** Returns true if finalizing any run failed (so strict mode can escalate). */
/**
 * Pull opice's `--fail-on-report-error` boolean flag out of the arg list (it's
 * an opice concept, not a bun flag) and return whether it was present plus the
 * remaining args.
 */
function extractStrict(args: string[]): { strict: boolean; rest: string[] } {
	const rest: string[] = []
	let strict = false
	for (const arg of args) {
		if (arg === '--fail-on-report-error') strict = true
		else rest.push(arg)
	}
	return { strict, rest }
}

function isTruthy(value: string | undefined): boolean {
	if (!value) return false
	const v = value.toLowerCase()
	return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** Returns true if finalizing any run failed (so strict mode can escalate). */
async function finalizeHandoffs(childPid: number | undefined, slug: string | undefined): Promise<boolean> {
	let files: string[]
	try {
		files = await fs.readdir(HANDOFF_DIR)
	} catch {
		return false // no handoff dir → no runs reported, nothing to finalize
	}
	const matching = childPid ? files.filter((f) => f === `${childPid}.json`) : files
	let failed = false
	for (const file of matching) {
		const full = path.join(HANDOFF_DIR, file)
		try {
			const handoff = JSON.parse(await fs.readFile(full, 'utf-8')) as Handoff
			await finishRun(handoff)
			printRunUrl(handoff, slug)
		} catch (err) {
			failed = true
			warn(`Failed to finalize run from ${file}: ${(err as Error).message}`)
		} finally {
			await fs.unlink(full).catch(() => {})
		}
	}
	return failed
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
