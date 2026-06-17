/**
 * Local "dashboard-level" report — a self-contained HTML file.
 *
 * Reporting is a swappable {@link Reporter} (startScenario / recordStep /
 * finishScenario / flush). The {@link HttpReporter} streams per-step events to
 * the hosted platform; with no `OPICE_DSN` it's a no-op and you get only bun's
 * pass/fail line. This `FileReporter` implements the same interface and, instead
 * of POSTing, renders the same per-step data (status, timing, intent/manual,
 * error, screenshot) into a single static `report.html` you open in a browser —
 * the dashboard view, locally, no server.
 *
 * Selected by {@link configureFromEnv} when `OPICE_REPORT_FILE` is set
 * (`opice test --report <file>` sets it for you). It needs no platform
 * credentials, so it's the zero-config local-DX path.
 *
 * Scope: events are kept in-memory per test process and the report is rewritten
 * on every scenario finish + flush. `bun test` runs one process per file, so a
 * single-file run (the usual authoring loop) produces a complete report; a
 * multi-file run writes one process's scenarios last (the CLI could aggregate
 * across files into one report — left as a follow-up).
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
	screenshot?: string // data URI
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

	constructor(private readonly reportPath: string) {}

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
			screenshot: await encodeScreenshot(event.screenshotPath),
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
		const html = renderReport([...this.scenarios.values()].sort((a, b) => a.id.localeCompare(b.id)))
		await fs.mkdir(path.dirname(path.resolve(this.reportPath)), { recursive: true })
		await fs.writeFile(this.reportPath, html, 'utf-8')
	}
}

async function encodeScreenshot(p: string | undefined): Promise<string | undefined> {
	if (!p) return undefined
	try {
		const buf = await fs.readFile(p)
		return `data:image/png;base64,${buf.toString('base64')}`
	} catch {
		return undefined
	}
}

type StatusMeta = { icon: string; cls: string }
const FALLBACK_META: StatusMeta = { icon: '◻', cls: 'pending' }
const STATUS_META: Record<string, StatusMeta> = {
	passed: { icon: '✔', cls: 'ok' },
	failed: { icon: '✕', cls: 'fail' },
	fixme: { icon: '⚠', cls: 'warn' },
	fixmepass: { icon: '⚠', cls: 'warn' },
	pending: FALLBACK_META,
	skipped: { icon: '⊘', cls: 'pending' },
}
function metaFor(status: string | undefined): StatusMeta {
	return (status ? STATUS_META[status] : undefined) ?? FALLBACK_META
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}

function fmtMs(ms: number | undefined): string {
	if (ms == null) return ''
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`
}

function renderStep(step: StepRecord): string {
	const meta = metaFor(step.status)
	const shot = step.screenshot
		? `<details class="shot"><summary>screenshot</summary><img src="${step.screenshot}" loading="lazy" /></details>`
		: ''
	const intent = step.intent ? `<div class="intent">${esc(step.intent)}</div>` : ''
	const manual = step.manual ? `<div class="manual">${esc(step.manual)}</div>` : ''
	const reason = step.reason ? `<div class="reason">${esc(step.reason)}</div>` : ''
	const error = step.error ? `<pre class="err">${esc(step.error)}</pre>` : ''
	return `<li class="step ${meta.cls}">
		<div class="srow"><span class="ic">${meta.icon}</span><span class="sname">${esc(step.name)}</span><span class="dur">${fmtMs(step.durationMs)}</span></div>
		${intent}${manual}${reason}${error}${shot}
	</li>`
}

function renderScenario(s: ScenarioRecord): string {
	const meta = metaFor(s.status ?? 'pending')
	const tags = [
		s.feature ? `<span class="tag">${esc(s.feature)}</span>` : '',
		...(s.roles ?? []).map(r => `<span class="tag role">${esc(r)}</span>`),
		(s.attempts && s.attempts > 1) ? `<span class="tag flaky">flaky ×${s.attempts}</span>` : '',
	].join('')
	return `<section class="scenario ${meta.cls}">
		<header><span class="ic">${meta.icon}</span><h2>${esc(s.name)}</h2><span class="dur">${fmtMs(s.durationMs)}</span></header>
		<div class="tags">${tags}</div>
		<ol class="steps">${s.steps.map(renderStep).join('')}</ol>
	</section>`
}

function renderReport(scenarios: ScenarioRecord[]): string {
	const total = scenarios.length
	const passed = scenarios.filter(s => s.status === 'passed').length
	const failed = scenarios.filter(s => s.status === 'failed').length
	const steps = scenarios.reduce((n, s) => n + s.steps.length, 0)
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opice report</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0;background:#0b1020;color:#e6e9f0}
.wrap{max-width:920px;margin:0 auto;padding:24px}
h1{font-size:18px;margin:0 0 4px}
.summary{display:flex;gap:16px;align-items:baseline;margin:0 0 20px;color:#9aa3b8;font-size:13px}
.summary b{color:#e6e9f0}
.summary .fail{color:#ff6b6b}
.summary .ok{color:#37d399}
.scenario{background:#141a2e;border-radius:12px;padding:16px 18px;margin:0 0 16px;box-shadow:0 1px 0 rgba(255,255,255,.04)}
.scenario>header{display:flex;align-items:center;gap:10px}
.scenario h2{font-size:15px;margin:0;flex:1;font-weight:600}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.tag{font-size:11px;padding:1px 8px;border-radius:999px;background:#222a44;color:#aeb6cc}
.tag.role{background:#1e2c4a}.tag.flaky{background:#4a3a1e;color:#ffce7a}
.steps{list-style:none;margin:8px 0 0;padding:0}
.step{padding:7px 10px;border-radius:8px;margin:4px 0;background:#0f1426}
.srow{display:flex;align-items:center;gap:8px}
.sname{flex:1}.dur{color:#7b86a3;font-variant-numeric:tabular-nums;font-size:12px}
.ic{width:18px;text-align:center;font-weight:700}
.ok>header .ic,.step.ok .ic{color:#37d399}
.fail>header .ic,.step.fail .ic{color:#ff6b6b}
.warn>header .ic,.step.warn .ic{color:#ffce7a}
.pending>header .ic,.step.pending .ic{color:#7b86a3}
.step.fail{background:#241620}
.intent{color:#9aa3b8;font-size:12.5px;margin:3px 0 0 26px}
.manual{color:#7b86a3;font-size:12px;margin:2px 0 0 26px;font-style:italic}
.reason{color:#ffce7a;font-size:12px;margin:2px 0 0 26px}
.err{white-space:pre-wrap;background:#1a0e14;color:#ff9c9c;padding:8px 10px;border-radius:6px;margin:6px 0 0 26px;font-size:12px;overflow:auto}
.shot{margin:6px 0 0 26px}
.shot summary{cursor:pointer;color:#7b86a3;font-size:12px}
.shot img{max-width:100%;border-radius:6px;margin-top:6px;box-shadow:0 2px 16px rgba(0,0,0,.4)}
</style></head><body><div class="wrap">
<h1>opice report</h1>
<div class="summary">
	<span><b>${total}</b> scenario${total === 1 ? '' : 's'}</span>
	<span class="ok"><b>${passed}</b> passed</span>
	${failed ? `<span class="fail"><b>${failed}</b> failed</span>` : ''}
	<span><b>${steps}</b> steps</span>
</div>
${scenarios.map(renderScenario).join('')}
</div></body></html>`
}
