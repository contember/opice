/**
 * Local "dashboard-level" report — a static `report.html` plus a sibling
 * `<report>-assets/` folder of screenshots.
 *
 * Reporting is a swappable {@link Reporter} (startScenario / recordStep /
 * finishScenario / flush). The {@link HttpReporter} streams per-step events to
 * the hosted platform; with no `OPICE_DSN` it's a no-op and you get only bun's
 * pass/fail line. This `FileReporter` implements the same interface and, instead
 * of POSTing, renders the same per-step data (status, timing, intent/manual,
 * error, screenshot) into `report.html` you open in a browser — the dashboard
 * view, locally, no server. Screenshots are written as files alongside (not
 * base64-inlined) so the HTML stays small and loads fast even on a big run.
 *
 * Selected by {@link configureFromEnv} when `OPICE_REPORT_FILE` is set
 * (`opice test --report <file>` sets it for you). It needs no platform
 * credentials, so it's the zero-config local-DX path.
 *
 * Scope: events are kept in-memory per test process and the report is rewritten
 * on every scenario finish + flush. `bun test` runs one process per file. For a
 * multi-file run, `opice test` provides a fresh shared `partsDir`: each process
 * persists its scenarios as a JSON part and every render is the union of all
 * parts, so the report stays complete instead of the last file clobbering the
 * rest. Under bare `bun test` (no CLI, no partsDir) only the running process's
 * scenarios are written — fine for the usual single-file authoring loop.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Reporter, ScenarioFinish, ScenarioSkip, ScenarioStart, StepEvent } from './reporter.js'

type StepRecord = {
	sequence: number
	kind?: string
	name: string
	status: StepEvent['status']
	durationMs: number
	error?: string
	intent?: string
	manual?: string
	reason?: string
	screenshot?: string // report-relative URL into the assets dir
}

type ScenarioRecord = {
	id: string
	name: string
	feature?: string
	seeds?: string[]
	roles?: string[]
	attempt: number
	steps: StepRecord[]
	status?: 'passed' | 'failed' | 'skipped'
	durationMs?: number
	attempts?: number
	reason?: string
}

export class FileReporter implements Reporter {
	private readonly scenarios = new Map<string, ScenarioRecord>()
	private seq = 0

	private writeCount = 0
	private shotCount = 0

	/**
	 * Screenshots live as files in a sibling `<report>-assets/` dir, referenced by
	 * relative URL — NOT inlined as base64. Inlining made the single HTML balloon
	 * to tens of MB on a large run (150+ scenarios × many screens), so it parsed
	 * slowly and the browser decoded every image up front. As files, the HTML
	 * stays text-only and `loading="lazy"` fetches only the screens on screen.
	 */
	private readonly assetsName: string
	private readonly assetsDir: string

	/**
	 * @param reportPath where the HTML report is written.
	 * @param partsDir   optional shared dir for cross-process aggregation. `bun
	 *   test` runs one process per file; when the CLI provides a (fresh-per-run)
	 *   dir, each process drops its scenarios there and every render is the UNION
	 *   of all parts — so a multi-file run yields one complete report instead of
	 *   the last file clobbering the rest. Absent (bare `bun test`), the reporter
	 *   just writes its own process's scenarios.
	 */
	constructor(
		private readonly reportPath: string,
		private readonly partsDir?: string,
	) {
		this.assetsName = assetsDirName(reportPath)
		this.assetsDir = path.join(path.dirname(reportPath), this.assetsName)
	}

	/** Copy a screenshot into the assets dir; return its report-relative URL. */
	private async materializeScreenshot(src: string | undefined): Promise<string | undefined> {
		if (!src) return undefined
		try {
			await fs.mkdir(this.assetsDir, { recursive: true })
			// pid keeps names unique across the per-file processes that share one dir.
			const name = `${process.pid}-${this.shotCount++}.png`
			await fs.copyFile(src, path.join(this.assetsDir, name))
			return `${this.assetsName}/${name}`
		} catch {
			return undefined
		}
	}

	async startScenario(input: ScenarioStart): Promise<string> {
		const id = `local-${this.seq++}-${process.pid}`
		this.scenarios.set(id, {
			id,
			name: input.name,
			feature: input.feature,
			seeds: input.seeds,
			roles: input.roles,
			attempt: 0,
			steps: [],
		})
		return id
	}

	async skipScenario(input: ScenarioSkip): Promise<void> {
		const id = `local-${this.seq++}-${process.pid}`
		this.scenarios.set(id, {
			id,
			name: input.name,
			feature: input.feature,
			seeds: input.seeds,
			roles: input.roles,
			attempt: 0,
			steps: [],
			status: 'skipped',
			durationMs: 0,
			reason: input.reason,
		})
		await this.write()
	}

	async recordStep(event: StepEvent): Promise<void> {
		const scenario = this.scenarios.get(event.scenarioId)
		if (!scenario) return
		const attempt = event.attempt ?? 0
		// Opice retries a flaky scenario; keep only the final attempt's steps.
		if (attempt > scenario.attempt) {
			scenario.attempt = attempt
			scenario.steps = []
		}
		if (attempt < scenario.attempt) return
		scenario.steps.push({
			sequence: event.sequence,
			kind: event.kind,
			name: event.name,
			status: event.status,
			durationMs: event.durationMs,
			error: event.error,
			intent: event.intent,
			manual: event.manual,
			reason: event.reason,
			screenshot: await this.materializeScreenshot(event.screenshotPath),
		})
		await this.write()
	}

	async finishScenario(input: ScenarioFinish): Promise<void> {
		const scenario = this.scenarios.get(input.scenarioId)
		if (!scenario) return
		scenario.status = input.status
		scenario.durationMs = input.durationMs
		scenario.attempts = input.attempts
		await this.write()
	}

	async flush(): Promise<void> {
		await this.write()
	}

	/** No platform round-trip to fail — local file writes never redden a run. */
	hadFailures(): boolean {
		return false
	}

	private async write(): Promise<void> {
		// Map iteration preserves insertion (= execution) order, which is what we
		// want. Don't sort by `id`: ids are `local-<seq>-<pid>`, so a lexicographic
		// compare orders `local-10` before `local-2` once there are ≥10 scenarios.
		const own = [...this.scenarios.values()]
		if (!this.partsDir) {
			await this.emit(own)
			return
		}
		// Multi-process aggregation: persist this process's scenarios as a JSON
		// "part", then render the union of every part. Write the part atomically
		// (tmp + rename) so a sibling process mid-render never reads a half-written
		// file. Scenario ids embed the pid, so the merged set never collides; parts
		// are concatenated in pid order (within a part, authoring order is kept).
		await fs.mkdir(this.partsDir, { recursive: true })
		const partFile = path.join(this.partsDir, `${process.pid}.json`)
		const tmp = `${partFile}.${this.writeCount++}.tmp`
		await fs.writeFile(tmp, JSON.stringify(own), 'utf-8')
		await fs.rename(tmp, partFile)
		await this.emit(await this.readParts(own))
	}

	/** Merge every sibling process's part into one ordered scenario list. */
	private async readParts(own: ScenarioRecord[]): Promise<ScenarioRecord[]> {
		const dir = this.partsDir
		if (!dir) return own
		let files: string[]
		try {
			files = await fs.readdir(dir)
		} catch {
			return own
		}
		const ownPart = `${process.pid}.json`
		const parts = files.filter(f => f.endsWith('.json')).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
		const out: ScenarioRecord[] = []
		for (const file of parts) {
			// Our own part is already in memory — splice `own` in at its pid-sorted
			// position rather than re-reading and re-parsing the (screenshot-laden)
			// file we just wrote. In the common single-file run this is the only part.
			if (file === ownPart) {
				out.push(...own)
				continue
			}
			try {
				const recs = JSON.parse(await fs.readFile(path.join(dir, file), 'utf-8')) as unknown
				if (Array.isArray(recs)) out.push(...(recs as ScenarioRecord[]))
			} catch {
				// A part being written right now — skip it; the next render picks it up.
			}
		}
		return out
	}

	private async emit(scenarios: ScenarioRecord[]): Promise<void> {
		const html = renderReport(scenarios)
		await fs.mkdir(path.dirname(path.resolve(this.reportPath)), { recursive: true })
		await fs.writeFile(this.reportPath, html, 'utf-8')
	}
}

/**
 * The screenshots dir sits beside the report and is named after it
 * (`report.html` → `report-assets/`), so several reports can share a directory
 * and the folder name reads as "belongs to this report". The CLI clears it at
 * the start of a run so a removed test's old screens don't linger.
 */
export function assetsDirName(reportPath: string): string {
	return path.basename(reportPath).replace(/\.[^.]*$/, '') + '-assets'
}

function esc(s: string): string {
	return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// Mirror the dashboard's fmtDuration (lib/format.ts) so a local report reads the
// same as the hosted run page: ms under a second, one-decimal seconds, m+s above.
function fmtDuration(ms: number | undefined): string {
	if (ms == null) return '—'
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

// Display status is computed (never stored), exactly as the dashboard derives it:
// a passed scenario carrying a pending stub reads `incomplete`, one carrying a
// tolerated `fixme` reads `warning`, and a flaky pass is still `passed` (amber
// badge). Steps map a pending-with-reason to `blocked`.
type Display = 'passed' | 'failed' | 'running' | 'warning' | 'incomplete' | 'skipped'

function scenarioDisplay(s: ScenarioRecord): Display {
	if (s.status === 'skipped') return 'skipped'
	if (s.status === 'failed') return 'failed'
	const hasPending = s.steps.some(st => st.status === 'pending')
	const hasFixme = s.steps.some(st => st.status === 'fixme' || st.status === 'fixmepass')
	if (hasPending) return 'incomplete'
	if (s.status === 'passed') return hasFixme ? 'warning' : 'passed'
	return hasFixme ? 'warning' : 'running'
}

const isFlaky = (s: ScenarioRecord): boolean => s.status === 'passed' && (s.attempts ?? 1) > 1

// Triage order — broken first, passing last, skipped last of all. Drives both the
// filter-tab order and the feature grouping/sort, matching the dashboard.
const SEVERITY: Record<Display, number> = { failed: 0, warning: 1, incomplete: 2, running: 3, passed: 4, skipped: 5 }
const FILTER_ORDER: Display[] = ['failed', 'warning', 'incomplete', 'running', 'passed', 'skipped']
const FILTER_LABEL: Record<string, string> = {
	failed: 'Failed', warning: 'Warnings', incomplete: 'Incomplete', running: 'Running', passed: 'Passed', skipped: 'Skipped',
}
const STATUS_LABEL: Record<string, string> = {
	passed: 'Passed', failed: 'Failed', running: 'Running', warning: 'Warning', incomplete: 'Incomplete',
	skipped: 'Skipped', pending: 'Pending', blocked: 'Blocked', fixme: 'Known failure', fixmepass: 'Unexpected pass',
}

// SVG marks drawn inside the status dot — geometrically centred at any size, as
// in the dashboard's StatusBadge (a glyph would sit low on its baseline).
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
function markSvg(status: string): string {
	switch (status) {
		case 'passed': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.3 8.4l2.4 2.4 5-5.2" ${STROKE}/></svg>`
		case 'failed': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" ${STROKE}/></svg>`
		case 'running': return `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="currentColor"/></svg>`
		case 'fixme': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 8.3q1.9-2.3 3.8 0t3.8 0" ${STROKE}/></svg>`
		case 'blocked': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.4 10.6l5.2-5.2" ${STROKE}/></svg>`
		case 'skipped': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7" ${STROKE}/></svg>`
		case 'incomplete':
		case 'warning':
		case 'fixmepass': return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v4.6" ${STROKE}/><circle cx="8" cy="11.6" r="1" fill="currentColor"/></svg>`
		default: return '' // pending — the dashed ring is the mark
	}
}
function statusDot(status: string, mini = false): string {
	return `<span class="status-dot ${status}${mini ? ' mini' : ''}" aria-label="${status}">${markSvg(status)}</span>`
}
function statusInline(status: string): string {
	return `<span class="status-inline ${status}">${statusDot(status)}<span>${STATUS_LABEL[status] ?? status}</span></span>`
}

const CLOCK = `<svg class="icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.2l2 1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function renderStepRow(step: StepRecord): string {
	const blocked = step.status === 'pending' && !!step.reason
	const display = blocked ? 'blocked' : step.status
	const cls = ['step', step.kind === 'invariant' ? 'invariant' : '', step.status === 'pending' ? 'pending' : '', blocked ? 'blocked' : ''].filter(Boolean).join(' ')
	const dur = step.status === 'pending' ? (blocked ? 'blocked' : 'not authored') : fmtDuration(step.durationMs)
	const kindTag = step.kind === 'invariant' ? `<span class="step-kind" title="Scenario-level acceptance">invariant</span>` : ''
	const intent = step.intent ? `<div class="step-intent">${esc(step.intent)}</div>` : ''
	const reasonLabel = blocked ? 'Blocked' : step.status === 'fixmepass' ? 'Marked fixme but passed' : 'Known failure'
	const reason = step.reason ? `<div class="step-reason">${reasonLabel} — ${esc(step.reason)}</div>` : ''
	const error = step.error ? `<div class="step-error">${esc(step.error)}</div>` : ''
	const shot = step.screenshot
		? `<a class="shot" href="${step.screenshot}" target="_blank" rel="noreferrer" title="Open full size"><img loading="lazy" src="${step.screenshot}" alt="${esc(step.name)}"/><div class="caption">${esc(step.name)}</div></a>`
		: ''
	const detail = (intent || reason || error || shot) ? `<div class="step-detail">${intent}${reason}${error}${shot}</div>` : ''
	return `<div class="${cls}"><span class="step-mark">${statusDot(display, true)}</span><span class="step-name">${kindTag}${esc(step.name)}</span><span class="duration">${dur}</span>${detail}</div>`
}

function renderRow(s: ScenarioRecord, showFeature: boolean): string {
	const disp = scenarioDisplay(s)
	const flaky = isFlaky(s)
		? `<span class="flaky-badge" title="Passed after ${s.attempts} attempts">flaky</span>`
		: ''
	const feature = (showFeature && s.feature) ? `<span class="wb-item-feature">${esc(s.feature)}</span>` : ''
	return `<button type="button" class="wb-item" data-id="${s.id}" data-status="${disp}" data-name="${esc(s.name.toLowerCase())}" data-feature="${esc((s.feature ?? '').toLowerCase())}">`
		+ `${statusDot(disp, true)}<span class="wb-item-name">${esc(s.name)}</span>${flaky}${feature}`
		+ `<span class="wb-item-dur tabular">${fmtDuration(s.durationMs)}</span></button>`
}

function renderDetail(s: ScenarioRecord): string {
	const disp = scenarioDisplay(s)
	const skipped = disp === 'skipped'
	const flaky = isFlaky(s)
		? `<span class="flaky-badge" title="Passed after ${s.attempts} attempts">flaky · ${s.attempts}×</span>`
		: ''
	const dur = skipped ? '' : `<span class="wb-detail-dur">${CLOCK}<span class="tabular">${fmtDuration(s.durationMs)}</span></span>`
	const metaChips = [
		s.feature ? `<span class="meta-chip feature" title="Feature / requirement">${esc(s.feature)}</span>` : '',
		...(s.seeds ?? []).map(x => `<span class="meta-chip seed" title="Required seed">${esc(x)}</span>`),
		...(s.roles ?? []).map(x => `<span class="meta-chip role" title="Acting role">${esc(x)}</span>`),
	].join('')
	const meta = metaChips ? `<div class="s-meta">${metaChips}</div>` : ''
	const body = skipped
		? `<div class="wb-skip-note">Skipped — ${s.reason ? esc(s.reason) : "excluded by the run's tier filter"}. This scenario was not executed.</div>`
		: s.steps.length
			? `<div class="steps">${s.steps.map(renderStepRow).join('')}</div>`
			: `<div class="muted" style="padding:12px 0;font-size:12.5px">No steps recorded.</div>`
	return `<div class="wb-detail-pane" data-id="${s.id}" hidden>`
		+ `<div class="wb-detail-bar">${statusInline(disp)}${flaky}<span class="pull"></span>${dur}</div>`
		+ `<h2 class="wb-detail-title">${esc(s.name)}</h2>${meta}${body}</div>`
}

// Feature grouping mirrors the dashboard: a feature earns a header band only when
// it covers ≥2 scenarios; single-scenario features and no-feature rows collapse
// into a flat "loose" tail (each carrying an inline feature chip). Everything
// sorts by severity (failures first), features tie-breaking alphabetically.
function groupScenarios(scenarios: ScenarioRecord[]): { groups: { feature: string; items: ScenarioRecord[]; sev: number }[]; loose: ScenarioRecord[] } {
	const sev = (s: ScenarioRecord) => SEVERITY[scenarioDisplay(s)]
	const byFeature = new Map<string, ScenarioRecord[]>()
	const loose: ScenarioRecord[] = []
	for (const s of scenarios) {
		if (!s.feature) { loose.push(s); continue }
		const list = byFeature.get(s.feature)
		if (list) list.push(s)
		else byFeature.set(s.feature, [s])
	}
	const groups: { feature: string; items: ScenarioRecord[]; sev: number }[] = []
	for (const [feature, items] of byFeature) {
		if (items.length < 2) { loose.push(items[0]!); continue }
		items.sort((a, b) => sev(a) - sev(b))
		groups.push({ feature, items, sev: sev(items[0]!) })
	}
	groups.sort((a, b) => a.sev - b.sev || a.feature.localeCompare(b.feature))
	loose.sort((a, b) => sev(a) - sev(b) || (a.feature ?? '￿').localeCompare(b.feature ?? '￿'))
	return { groups, loose }
}

const LOGO = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7" cy="11" r="3.4"/><circle cx="25" cy="11" r="3.4"/><circle cx="16" cy="17" r="8.5"/><path d="M11 18 Q16 24 21 18"/><path d="M14.5 21.5 Q16 22.4 17.5 21.5" stroke-width="1.4"/><circle cx="13" cy="15.2" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="15.2" r="1" fill="currentColor" stroke="none"/></svg>`

function renderReport(scenarios: ScenarioRecord[]): string {
	const counts: Record<string, number> = {}
	for (const s of scenarios) {
		const d = scenarioDisplay(s)
		counts[d] = (counts[d] ?? 0) + 1
	}
	const executed = scenarios.filter(s => scenarioDisplay(s) !== 'skipped')
	const passed = executed.filter(s => scenarioDisplay(s) === 'passed').length
	const failed = executed.filter(s => scenarioDisplay(s) === 'failed').length
	const stepCount = scenarios.reduce((n, s) => n + s.steps.length, 0)
	const skipped = counts['skipped'] ?? 0
	const runStatus = (['failed', 'warning', 'incomplete', 'running'] as Display[]).find(st => counts[st]) ?? 'passed'

	const { groups, loose } = groupScenarios(scenarios)
	const tabs = [`<button type="button" class="wb-tab active" data-filter="all">All <span class="wb-tab-count">${scenarios.length}</span></button>`]
		.concat(FILTER_ORDER.filter(st => counts[st]).map(st =>
			`<button type="button" class="wb-tab" data-filter="${st}">${statusDot(st, true)}${FILTER_LABEL[st]} <span class="wb-tab-count">${counts[st]}</span></button>`))
		.join('')
	const listInner = groups.map(g =>
		`<div class="wb-group"><div class="wb-group-head">${esc(g.feature)}</div>${g.items.map(s => renderRow(s, false)).join('')}</div>`).join('')
		+ (loose.length ? `<div class="wb-loose">${loose.map(s => renderRow(s, true)).join('')}</div>` : '')
		+ `<div class="wb-list-empty" id="wb-empty" hidden>No scenarios match.</div>`
	const sep = `<span class="sep">·</span>`
	const subtitle = [
		`<span class="tabular">${executed.length} scenario${executed.length === 1 ? '' : 's'}</span>`,
		passed ? `${sep}<span class="tabular">${passed} passed</span>` : '',
		failed ? `${sep}<span class="tabular" style="color:var(--fail)">${failed} failed</span>` : '',
		`${sep}<span class="tabular">${stepCount} step${stepCount === 1 ? '' : 's'}</span>`,
		skipped ? `${sep}<span class="tabular">${skipped} skipped</span>` : '',
	].join('')

	const main = scenarios.length === 0
		? `<div class="empty"><div class="empty-title">No scenarios reported</div></div>`
		: `<div class="workbench">
	<div class="wb-bar"><div class="wb-tabs">${tabs}</div><input class="wb-search" id="wb-search" type="search" placeholder="Search scenarios…"></div>
	<div class="wb-body">
		<div class="wb-list">${listInner}</div>
		<div class="wb-detail" id="wb-detail">${scenarios.map(renderDetail).join('')}</div>
	</div>
</div>`

	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opice report</title>
<style>${STYLES}</style></head><body>
<header class="app-header"><div class="inner"><span class="brand"><span class="brand-mark">${LOGO}</span><span class="brand-text"><span class="brand-name">opice</span><span class="brand-sub">Local report</span></span></span></div></header>
<main class="wide">
<div class="page-head"><h1>${statusInline(runStatus)}<span>Report</span></h1><div class="subtitle">${subtitle}</div></div>
${main}
</main>
<div class="theme-switch"><span class="label">Theme</span><button type="button" class="opt" data-theme-opt="auto">Auto</button><button type="button" class="opt" data-theme-opt="light">Light</button><button type="button" class="opt" data-theme-opt="dark">Dark</button></div>
<script>${SCRIPT}</script>
</body></html>`
}

// Ported subset of the dashboard's styles.css — same tokens (light/dark, muted
// green), status marks, workbench, and step grid, so the local report reads like
// the hosted run page rather than a separate skin.
const STYLES = `
:root{--bg:#f3f4ee;--surface:#fff;--surface-2:#ebede4;--surface-hover:#f7f8f2;--border:#d4d7c8;--border-soft:#e2e4d7;--border-strong:#b8bca7;--text:#1c2317;--text-soft:#46503a;--text-mute:#6a785a;--text-faint:#98a085;--accent:#3a6a30;--accent-soft:#d8e3c6;--accent-tint:#eef3e3;--pass:#2f7a2a;--pass-soft:#d7e9c9;--fail:#b03020;--fail-soft:#f1d6cc;--run:#9c6a18;--run-soft:#f0dcae;--content-max:1360px;--font-sans:'Inter',system-ui,-apple-system,BlinkMacSystemFont,sans-serif;--font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme]){--bg:#0f1310;--surface:#161b16;--surface-2:#1c221c;--surface-hover:#1f2520;--border:#2c342b;--border-soft:#232a23;--border-strong:#3b4538;--text:#e6eadb;--text-soft:#b4bea4;--text-mute:#7c886a;--text-faint:#4f5945;--accent:#9bbf7a;--accent-soft:#243018;--accent-tint:#1a2412;--pass:#88c46c;--pass-soft:#1f2c16;--fail:#e07458;--fail-soft:#3a1a12;--run:#d99c36;--run-soft:#36280e}}
:root[data-theme="dark"]{--bg:#0f1310;--surface:#161b16;--surface-2:#1c221c;--surface-hover:#1f2520;--border:#2c342b;--border-soft:#232a23;--border-strong:#3b4538;--text:#e6eadb;--text-soft:#b4bea4;--text-mute:#7c886a;--text-faint:#4f5945;--accent:#9bbf7a;--accent-soft:#243018;--accent-tint:#1a2412;--pass:#88c46c;--pass-soft:#1f2c16;--fail:#e07458;--fail-soft:#3a1a12;--run:#d99c36;--run-soft:#36280e}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-sans);font-size:13.5px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:2px}
code,.mono{font-family:var(--font-mono);font-size:.88em;letter-spacing:-.01em}
.muted{color:var(--text-mute)}.sep{color:var(--text-faint)}.tabular{font-variant-numeric:tabular-nums}
header.app-header{position:relative;border-bottom:1px solid var(--border);background:var(--surface)}
header.app-header::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:linear-gradient(90deg,var(--accent) 0%,var(--accent) 30%,color-mix(in srgb,var(--accent) 50%,transparent) 60%,transparent 100%)}
header.app-header .inner{display:flex;align-items:center;gap:24px;padding:14px 24px;max-width:var(--content-max);margin:0 auto}
.brand{display:inline-flex;align-items:center;gap:10px;line-height:1;color:var(--text)}
.brand-mark{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border:1px solid var(--accent-soft);border-radius:8px;background:var(--accent-tint);color:var(--accent)}
.brand-text{display:inline-flex;flex-direction:column;gap:3px}
.brand-name{font-size:15px;font-weight:600;letter-spacing:-.015em;line-height:1}
.brand-sub{font-family:var(--font-mono);font-size:9.5px;font-weight:500;color:var(--text-mute);letter-spacing:.18em;text-transform:uppercase;line-height:1}
main{max-width:var(--content-max);margin:0 auto;padding:20px 24px 40px}
.page-head{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-soft)}
.page-head h1{font-weight:600;font-size:22px;line-height:1.25;letter-spacing:-.01em;margin:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.page-head .subtitle{color:var(--text-mute);font-size:13px;margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 8px;align-items:center}
.status-dot{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;font-size:11px;line-height:1;flex-shrink:0;font-weight:700;border:1px solid transparent}
.status-dot svg{width:62%;height:62%;display:block}
.status-dot.passed{background:var(--pass);color:#fff}.status-dot.failed{background:var(--fail);color:#fff}
.status-dot.running{background:var(--run);color:#fff;animation:breathe 1.6s ease-in-out infinite}
.status-dot.incomplete{background:var(--text-soft);color:#fff}
.status-dot.skipped{background:transparent;color:var(--text-soft);border-color:color-mix(in srgb,var(--text-soft) 45%,transparent)}
.status-dot.warning,.status-dot.fixme,.status-dot.fixmepass{background:var(--run);color:#fff}
.status-dot.pending{background:transparent;color:var(--text-faint);border-color:color-mix(in srgb,var(--text-faint) 55%,transparent);border-style:dashed}
.status-dot.blocked{background:transparent;color:var(--run);border-color:color-mix(in srgb,var(--run) 55%,transparent);border-style:dashed}
.status-dot.mini{width:14px;height:14px;font-size:8px;border-width:1.5px}
.status-dot.mini.passed{background:transparent;color:var(--pass);border-color:color-mix(in srgb,var(--pass) 55%,transparent)}
.status-dot.mini.running{background:transparent;color:var(--run);border-color:color-mix(in srgb,var(--run) 55%,transparent)}
.status-dot.mini.incomplete{background:transparent;color:var(--text-soft);border-color:color-mix(in srgb,var(--text-soft) 55%,transparent)}
.status-dot.mini.warning,.status-dot.mini.fixme,.status-dot.mini.fixmepass{background:transparent;color:var(--run);border-color:color-mix(in srgb,var(--run) 55%,transparent)}
.status-dot.mini.failed{background:var(--fail);color:#fff;border-color:transparent}
.status-dot.mini.skipped{background:transparent;color:var(--text-soft);border-color:color-mix(in srgb,var(--text-soft) 45%,transparent)}
.status-dot.mini.pending{background:transparent;color:var(--text-faint);border-color:color-mix(in srgb,var(--text-faint) 55%,transparent);border-style:dashed}
.status-dot.mini.blocked{background:transparent;color:var(--run);border-color:color-mix(in srgb,var(--run) 55%,transparent);border-style:dashed}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.55}}
.status-inline{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;padding:2px 8px 2px 6px;border-radius:999px;border:1px solid var(--border)}
.status-inline .status-dot{width:12px;height:12px;font-size:8px}
.status-inline.passed{color:var(--pass);background:var(--pass-soft);border-color:color-mix(in srgb,var(--pass) 30%,transparent)}
.status-inline.failed{color:var(--fail);background:var(--fail-soft);border-color:color-mix(in srgb,var(--fail) 30%,transparent)}
.status-inline.running,.status-inline.warning{color:var(--run);background:var(--run-soft);border-color:color-mix(in srgb,var(--run) 30%,transparent)}
.status-inline.incomplete{color:var(--text-soft);background:color-mix(in srgb,var(--text-soft) 12%,transparent);border-color:color-mix(in srgb,var(--text-soft) 30%,transparent)}
.workbench{margin-top:8px;border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden}
.wb-bar{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--surface-2)}
.wb-tabs{display:flex;align-items:center;gap:5px;flex-wrap:wrap;flex:1;min-width:0}
.wb-tab{display:inline-flex;align-items:center;gap:6px;height:28px;font-family:var(--font-sans);font-size:12.5px;font-weight:500;color:var(--text-mute);background:transparent;border:1px solid transparent;border-radius:999px;padding:0 11px;cursor:pointer}
.wb-tab:hover{color:var(--text);background:var(--surface-hover)}
.wb-tab.active{color:var(--text);background:var(--accent-tint);border-color:var(--accent-soft)}
.wb-tab .status-dot{margin-left:-2px}
.wb-tab-count{font-family:var(--font-mono);font-size:11px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.wb-tab.active .wb-tab-count{color:var(--accent)}
.wb-search{flex-shrink:0;width:220px;max-width:40%;height:28px;font-family:var(--font-sans);font-size:12.5px;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:0 11px}
.wb-search:focus{outline:none;border-color:var(--accent)}.wb-search::placeholder{color:var(--text-faint)}
.wb-body{display:grid;grid-template-columns:320px 1fr;height:calc(100vh - 220px);min-height:460px}
.wb-list{overflow-y:auto;border-right:1px solid var(--border);background:var(--surface)}
.wb-list-empty{padding:24px 16px;color:var(--text-mute);font-size:12.5px}
.wb-group{padding-bottom:6px}.wb-group+.wb-group,.wb-group+.wb-loose{border-top:1px solid var(--border-soft)}.wb-loose{padding:6px 0}
.wb-group-head{font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-faint);padding:14px 16px 7px}
.wb-item{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:transparent;border:none;border-left:2px solid transparent;padding:8px 14px;cursor:pointer;font:inherit;color:var(--text)}
.wb-item:hover{background:var(--surface-hover)}.wb-item.active{background:var(--accent-tint);border-left-color:var(--accent)}
.wb-item-name{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.4;letter-spacing:-.005em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wb-item.active .wb-item-name{font-weight:600}
.wb-item-feature{flex-shrink:0;font-family:var(--font-mono);font-size:10px;color:var(--text-faint);padding:1px 6px;border-radius:999px;border:1px solid var(--border-soft);background:var(--surface-2)}
.wb-item-dur{flex-shrink:0;padding-left:6px;font-family:var(--font-mono);font-size:10.5px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.flaky-badge{flex-shrink:0;font-family:var(--font-mono);font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--run);background:var(--run-soft);border:1px solid color-mix(in srgb,var(--run) 30%,transparent);border-radius:999px;padding:1px 6px}
.wb-detail{overflow-y:auto;padding:22px 28px 32px}
.wb-detail-bar{display:flex;align-items:center;gap:10px;margin-bottom:14px}.wb-detail-bar .pull{flex:1}
.wb-detail-dur{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--text-mute)}.wb-detail-dur .icon{color:var(--text-faint)}
.wb-detail-title{font-size:21px;font-weight:600;line-height:1.25;letter-spacing:-.015em;margin:0 0 14px}
.s-meta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}
.meta-chip{font-family:var(--font-mono);font-size:11px;line-height:1.4;padding:1px 7px;border-radius:999px;border:1px solid var(--border);color:var(--text-mute);background:var(--surface-2)}
.meta-chip.feature{color:var(--accent);background:var(--accent-tint);border-color:color-mix(in srgb,var(--accent) 28%,transparent)}
.meta-chip.seed::before{content:'seed ';color:var(--text-faint)}.meta-chip.role::before{content:'@';color:var(--text-faint)}
.wb-skip-note{margin:12px 0;padding:10px 12px;font-size:12.5px;line-height:1.5;color:var(--text-soft);background:color-mix(in srgb,var(--text-soft) 8%,transparent);border:1px solid color-mix(in srgb,var(--text-soft) 22%,transparent);border-radius:8px}
.steps{padding:0}
.step{display:grid;grid-template-columns:16px 1fr auto;column-gap:11px;align-items:center;padding:9px 2px;border-top:1px solid var(--border-soft)}
.step:first-child{border-top:none}.step .step-mark{grid-column:1}
.step .step-name{grid-column:2;font-size:13px;font-weight:400;color:var(--text-soft)}
.step .duration{grid-column:3;font-family:var(--font-mono);font-size:11.5px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.step .step-detail{grid-column:2 / -1;margin-top:8px}
.step .step-intent{font-size:12px;line-height:1.5;color:var(--text-mute);border-left:2px solid var(--border);padding:2px 0 2px 10px;margin-bottom:6px}
.step .step-kind{display:inline-block;font-family:var(--font-mono);font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:3px;padding:0 5px;margin-right:7px;vertical-align:middle}
.step .step-reason{font-size:12px;line-height:1.5;color:var(--run);background:var(--run-soft);border:1px solid color-mix(in srgb,var(--run) 30%,transparent);border-left:3px solid var(--run);padding:8px 12px;margin-bottom:6px;border-radius:0 4px 4px 0}
.step .step-error{font-family:var(--font-mono);font-size:12px;line-height:1.5;color:var(--fail);background:var(--fail-soft);border:1px solid color-mix(in srgb,var(--fail) 30%,transparent);border-left:3px solid var(--fail);padding:8px 12px;white-space:pre-wrap;border-radius:0 4px 4px 0}
.step.pending .step-name{color:var(--text-mute)}.step.pending .duration{font-style:italic;color:var(--text-faint)}
.step.blocked .step-name,.step.blocked .duration{color:var(--run)}
.shot{display:inline-block;margin-top:8px;padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;max-width:100%}
.shot:hover{border-color:var(--border-strong)}.shot img{display:block;max-width:100%;height:auto;border-radius:2px}
.shot .caption{font-size:11.5px;color:var(--text-mute);margin-top:6px;padding:0 2px;font-variant-numeric:tabular-nums}
.empty{padding:48px 24px;border:1px dashed var(--border);border-radius:6px;text-align:center;color:var(--text-mute);background:var(--surface)}
.empty .empty-title{font-size:15px;font-weight:600;color:var(--text)}
.theme-switch{max-width:var(--content-max);margin:0 auto;padding:12px 24px 28px;display:flex;align-items:center;gap:6px;font-size:12px}
.theme-switch .label{color:var(--text-faint);margin-right:6px;font-weight:500}
.theme-switch .opt{appearance:none;background:none;border:1px solid transparent;padding:3px 8px;border-radius:4px;font:inherit;color:var(--text-mute);cursor:pointer}
.theme-switch .opt:hover{color:var(--text);background:var(--surface-hover)}
.theme-switch .opt.active{color:var(--text);background:var(--accent-tint);border-color:var(--accent-soft)}
@media (max-width:720px){.wb-bar{flex-wrap:wrap}.wb-search{width:100%;max-width:none}.wb-body{grid-template-columns:1fr;height:auto;min-height:0}.wb-list{border-right:none;border-bottom:1px solid var(--border);max-height:320px}}
`

// Vanilla controller: row selection (master/detail), status-tab + search
// filtering, and the theme switch. Written without template literals so the
// generated <script> carries no template-literal escaping hazards.
const SCRIPT = `
(function(){
var root=document.documentElement;
var rows=[].slice.call(document.querySelectorAll('.wb-item'));
var panes=[].slice.call(document.querySelectorAll('.wb-detail-pane'));
var tabs=[].slice.call(document.querySelectorAll('.wb-tab'));
var search=document.getElementById('wb-search');
var empty=document.getElementById('wb-empty');
var filter='all',q='';
function select(id){
	rows.forEach(function(r){r.classList.toggle('active',r.getAttribute('data-id')===id);});
	panes.forEach(function(p){p.hidden=p.getAttribute('data-id')!==id;});
}
function visible(r){
	if(filter!=='all'&&r.getAttribute('data-status')!==filter)return false;
	if(q&&r.getAttribute('data-name').indexOf(q)<0&&r.getAttribute('data-feature').indexOf(q)<0)return false;
	return true;
}
function apply(){
	var shown=[];
	rows.forEach(function(r){var v=visible(r);r.hidden=!v;if(v)shown.push(r);});
	[].slice.call(document.querySelectorAll('.wb-group,.wb-loose')).forEach(function(g){
		g.hidden=![].slice.call(g.querySelectorAll('.wb-item')).some(function(r){return !r.hidden;});
	});
	if(empty)empty.hidden=shown.length>0;
	var active=rows.filter(function(r){return r.classList.contains('active');})[0];
	if(!active||active.hidden){
		if(shown.length)select(shown[0].getAttribute('data-id'));
		else{panes.forEach(function(p){p.hidden=true;});rows.forEach(function(r){r.classList.remove('active');});}
	}
}
rows.forEach(function(r){r.addEventListener('click',function(){select(r.getAttribute('data-id'));});});
tabs.forEach(function(t){t.addEventListener('click',function(){filter=t.getAttribute('data-filter');tabs.forEach(function(x){x.classList.toggle('active',x===t);});apply();});});
if(search)search.addEventListener('input',function(){q=search.value.trim().toLowerCase();apply();});
function setTheme(v){
	if(v==='auto')root.removeAttribute('data-theme');else root.setAttribute('data-theme',v);
	[].slice.call(document.querySelectorAll('.theme-switch .opt')).forEach(function(b){b.classList.toggle('active',b.getAttribute('data-theme-opt')===v);});
	try{localStorage.setItem('opice-theme',v);}catch(e){}
}
[].slice.call(document.querySelectorAll('.theme-switch .opt')).forEach(function(b){b.addEventListener('click',function(){setTheme(b.getAttribute('data-theme-opt'));});});
var saved=null;try{saved=localStorage.getItem('opice-theme');}catch(e){}
setTheme(saved||'auto');
var first=rows[0];if(first)select(first.getAttribute('data-id'));
apply();
})();
`
