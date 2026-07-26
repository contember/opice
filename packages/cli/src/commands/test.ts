import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from '../config'
import { parseOpiceDsn } from '../dsn'
import { extractBoolean, extractInteger, extractList, extractOptionalValueFlag, extractValue } from '../args'
import { changedPaths, defaultBase, detectGitMeta } from '../git'
import { existsInRepo, resolveImpact } from '../impact'

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
	const { value: tier, rest: afterTier } = extractValue(args, 'tier')
	const resolvedTier = tier ?? process.env['OPICE_TIER'] ?? config?.tier

	// `--fail-on-report-error` turns a swallowed reporting failure into a non-zero
	// exit (default is best-effort: reporting never reddens CI). CLI flag wins over
	// OPICE_REPORT_STRICT, which wins over opice.config.json's `failOnReportError`.
	// We propagate it to the harness via OPICE_REPORT_STRICT (it fails the run from
	// a scenario's afterAll) AND honour it here for the POST /finish finalize.
	const { present: strictFlag, rest: afterStrict } = extractBoolean(afterTier, 'fail-on-report-error')
	const strict = strictFlag || isTruthy(process.env['OPICE_REPORT_STRICT']) || config?.failOnReportError === true

	// `--select FILE[,FILE...]` (repeatable) → run these scenarios IN ADDITION to
	// the tier, deduplicated (a selected scenario already within the tier is not
	// run twice). The harness reads OPICE_SELECT; CLI flag wins over the env var.
	// Canonical use: a PR runs `--tier critical --select <changed test files>` so a
	// touched standard/extended scenario runs without the whole suite.
	const { values: selectValues, rest: afterSelect } = extractList(afterStrict, 'select')
	const explicitSelect = (selectValues.join(',') || undefined) ?? process.env['OPICE_SELECT']

	// `--impacted [BASE]` → ask the platform which scenarios the working tree's
	// changes reach (from their recorded footprints) and fold those test files
	// into the selection. Composes with --tier and --select: all three are a
	// union, so the always-on tier still runs and nothing is ever subtracted.
	// Fails OPEN — an unreachable platform or an empty index adds nothing and
	// leaves the tier exactly as it was.
	// No `isValue`: a bare `--impacted` NEVER consumes the following token. A git
	// ref and a bun test-name filter are indistinguishable — `opice test
	// --impacted login` would otherwise diff against a ref called `login` AND
	// drop the filter bun was meant to receive, changing both halves of the run.
	// Use `--impacted=<ref>` to name a base. Same rule as `--video`, above.
	const impactedFlag = extractOptionalValueFlag(afterSelect, 'impacted')
	const afterImpacted = impactedFlag.rest
	const impacted = impactedFlag.present
		? await resolveImpact(
			{ ...(project ? { project } : {}), ...(endpoint ? { endpoint } : {}) },
			{ ...(impactedFlag.value ? { base: impactedFlag.value } : {}), label: '--impacted' },
		)
		: null
	// Fails open by construction: when the query can't be answered (no
	// credentials, no index, an unreachable platform — each already warned about
	// by resolveImpact) the selection is simply empty and the tier runs alone.
	// That is a correct, if less targeted, run; a dashboard outage must never be
	// able to shrink what CI covers.
	if (impactedFlag.present && !impacted) warn('--impacted added nothing — running the tier alone.')
	const impactedFiles = impacted?.files ?? []
	// A test file the PR itself CHANGED is selected from git, not from the index.
	// The index cannot know about it: a newly added test has never run, so it has
	// no edges, and a renamed one has edges under its OLD path — which
	// `impactedTestFiles` then drops because that path no longer exists. Either
	// way `--tier critical --impacted` would skip the very test the PR is about,
	// which is the single most obvious selection anyone expects. Git knows the
	// current path, so it answers directly, and it answers even when the platform
	// could not be reached at all.
	const changedTests = impactedFlag.present ? changedTestFiles(impacted?.paths) : []
	const select = [explicitSelect, ...impactedFiles, ...changedTests].filter(Boolean).join(',') || undefined
	if (changedTests.length > 0) {
		console.error(`[opice] --impacted: ${changedTests.length} changed test file(s) selected directly from the diff.`)
	}

	// `--report [file]` → a local HTML report (no platform creds). The harness
	// reporter reads OPICE_REPORT_FILE; the flag is the friendly door. A bare
	// `--report` only consumes a following token when it *looks like* a report
	// path (ends in .html/.htm) so it never swallows a bun test-file arg.
	const report = extractOptionalValueFlag(afterImpacted, 'report', looksLikeReportPath)
	const afterReport = report.rest
	const reportFile = (report.present ? (report.value ?? DEFAULT_REPORT_FILE) : undefined) ?? process.env['OPICE_REPORT_FILE']

	// `--video [=dir]` → record a screen capture of each scenario's walkthrough,
	// saved as `<scenario-name>.webm` (great for tutorial footage). Off by default
	// — it's overhead nobody wants on a normal CI run. The harness reads
	// OPICE_VIDEO / OPICE_VIDEO_DIR; the flag is the friendly door. A custom dir
	// MUST use the `--video=dir` form — a bare `--video` never consumes the next
	// token (a dir name is indistinguishable from a bun test-name filter, so
	// swallowing it would silently run the whole suite). No `isValue` ⇒ never
	// consume a following arg.
	const videoFlag = extractOptionalValueFlag(afterReport, 'video')
	const afterVideo = videoFlag.rest
	const videoEnabled = videoFlag.present || isTruthy(process.env['OPICE_VIDEO'])
	const videoDir = videoFlag.value ?? process.env['OPICE_VIDEO_DIR']

	// `--footprint[=network|full]` → record what each scenario touches (files,
	// components, endpoints, GraphQL models). A bare `--footprint` means `full`.
	// Like `--video`, the bare form never consumes the next token — a mode name is
	// indistinguishable from a bun test-file arg, so use `--footprint=network`.
	// CLI flag wins over OPICE_FOOTPRINT, which wins over opice.config.json.
	const footprintFlag = extractOptionalValueFlag(afterVideo, 'footprint')
	const afterFootprint = footprintFlag.rest
	const footprint = footprintFlag.present
		? (footprintFlag.value ?? 'full')
		: (process.env['OPICE_FOOTPRINT'] ?? config?.footprint)
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
		...(git.commitTime ? { OPICE_COMMIT_TIME: git.commitTime } : {}),
		...(resolvedTier ? { OPICE_TIER: resolvedTier } : {}),
		...(select ? { OPICE_SELECT: select } : {}),
		...(strict ? { OPICE_REPORT_STRICT: '1' } : {}),
		...(reportFile ? { OPICE_REPORT_FILE: reportFile } : {}),
		...(reportPartsDir ? { OPICE_REPORT_PARTS_DIR: reportPartsDir } : {}),
		...(videoEnabled ? { OPICE_VIDEO: '1' } : {}),
		...(videoDir ? { OPICE_VIDEO_DIR: videoDir } : {}),
		...(footprint ? { OPICE_FOOTPRINT: footprint } : {}),
	}

	// `--retries=N` (opice's spelling) → bun's `--retry=N`, the global default
	// retry budget for every scenario. CLI flag wins over opice.config.json's
	// `retries`. A per-scenario `walkthrough`/meta `retries` overrides both.
	const { value: retries, rest } = extractInteger(afterFootprint, 'retries')
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

/** `*.test.*` / `*.spec.*` among the changed paths, deduplicated and still present. */
function changedTestFiles(known?: readonly string[]): string[] {
	let paths = known
	if (!paths) {
		// `--impacted` could not run its query (no credentials, no platform), but
		// the diff is local and free — the selection still only ADDS, so answering
		// this half is strictly better than answering neither.
		try {
			paths = changedPaths(defaultBase())
		} catch {
			return []
		}
	}
	// A deleted file is in the diff too; selecting it would name a test bun cannot
	// run. `existsInRepo` rather than a bare `existsSync`: these paths are
	// repo-relative (git runs from the root), so resolving them against the
	// current directory would find nothing whenever CI invokes opice from a
	// package subdirectory — and would silently drop the selection it just made.
	return [...new Set(paths.filter((p) => TEST_FILE_RE.test(p)))].sort().filter(existsInRepo)
}

const TEST_FILE_RE = /\.(?:test|spec)\.[tj]sx?$/i
