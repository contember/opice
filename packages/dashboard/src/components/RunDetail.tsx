import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { fmtDate, fmtDuration, fmtRelative } from '../lib/format'
import { ClockIcon } from './Icon'
import { Loading } from './Loading'
import { Polaroid } from './Polaroid'
import { StatusMark, StatusMarkInline } from './StatusBadge'

// ── shared shapes ────────────────────────────────────────────────────────────
// These mirror the worker's RunSchema / ScenarioSchema / StepSchema. Both RPC
// surfaces (operator `AppRouter` and the public `ShareRouter`) return the same
// shapes, so a single read-only renderer serves the operator run page and the
// anonymous share view alike.

export type ScenarioStatus = 'running' | 'passed' | 'failed' | 'warning' | 'incomplete' | 'skipped'

export interface RunSummary {
	id: string
	status: 'running' | 'passed' | 'failed' | 'incomplete' | 'warning'
	branch: string | null
	commitSha: string | null
	startedAt: number
	finishedAt: number | null
	/** The tier this run selected (OPICE_TIER); null = ran everything. */
	tier?: string | null
	/** Scenarios the tier filter excluded from this run. */
	skippedScenarios?: number
}

export interface Scenario {
	id: string
	name: string
	status: ScenarioStatus
	hash: string | null
	testFile: string | null
	feature: string | null
	seeds: string[]
	roles: string[]
	tier: string | null
	skipReason: string | null
	durationMs: number | null
	attempts: number
	/** URL of the scenario's walkthrough video (opt-in OPICE_VIDEO), or null. */
	videoUrl: string | null
	/** Footprint counts (opt-in OPICE_FOOTPRINT), or null when not collected. */
	footprint: FootprintSummary | null
}

export interface Step {
	id: number
	sequence: number
	kind: 'step' | 'invariant'
	name: string
	status: 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
	durationMs: number
	error: string | null
	intent: string | null
	reason: string | null
	screenshotUrl: string | null
	// Screenshot was captured but its upload to R2 failed (transient R2 error,
	// swallowed so it couldn't fail the run) — shown as a gap, not a real image.
	screenshotFailed: boolean
}

/** Counts carried on every scenario read — enough to decide whether to offer the panel. */
export interface FootprintSummary {
	files: number
	components: number
	endpoints: number
	models: number
	requests: number
	warnings: number
}

export interface FootprintRequest {
	/** Sequence of the step that was active when the request started; null = outside any step. */
	step: number | null
	method: string
	route: string
	status: number | null
	durationMs: number | null
	operations?: { type: string; name?: string; rootFields: string[]; models: { name: string; write: boolean }[] }[]
}

/** The full footprint blob, fetched on demand when the panel is opened. */
export interface FootprintDetail {
	collected: string[]
	files: { path: string; source: string; executed?: number }[]
	components: string[]
	requests: FootprintRequest[]
	endpoints: { route: string; methods: string[]; count: number }[]
	models: { name: string; write: boolean }[]
	warnings?: string[]
}

/** Fetch the steps of one scenario. The caller binds the right RPC client. */
export type LoadSteps = (scenarioId: string) => Promise<Step[]>

/** Fetch one scenario's footprint. Null when it wasn't collected or is unreadable. */
export type LoadFootprint = (scenarioId: string) => Promise<FootprintDetail | null>

// A passed scenario that needed more than one attempt is flaky — it failed at
// least once before passing within the retry budget.
const isFlaky = (s: Scenario): boolean => s.status === 'passed' && s.attempts > 1

// Filter tabs, surfacing problems first. 'all' is always present; the rest only
// render when the run actually carries scenarios in that state.
const FILTER_ORDER: ScenarioStatus[] = ['failed', 'warning', 'incomplete', 'running', 'passed', 'skipped']
const FILTER_LABEL: Record<ScenarioStatus, string> = {
	failed: 'Failed',
	warning: 'Warnings',
	incomplete: 'Incomplete',
	running: 'Running',
	passed: 'Passed',
	skipped: 'Skipped',
}

// Triage order: broken first, passing last, skipped (never ran) last of all.
// Used to sort both feature groups (by their worst scenario) and the rows within
// them, so the eye and the auto-selection land on the same place.
const SEVERITY: Record<ScenarioStatus, number> = {
	failed: 0,
	warning: 1,
	incomplete: 2,
	running: 3,
	passed: 4,
	skipped: 5,
}

/**
 * Read-only run detail: the run title + meta header and the scenario workbench.
 * Reused by the operator run page and the anonymous share view — each caller
 * supplies the data (already fetched via its own RPC client) and a `loadSteps`
 * binding for the lazy per-scenario steps query. Callers render their own
 * breadcrumb above and any operator-only chrome (e.g. share management) below.
 */
export function RunDetail({
	run,
	scenarios,
	scenariosLoading,
	loadSteps,
	loadFootprint,
}: {
	run: RunSummary
	scenarios: Scenario[] | undefined
	scenariosLoading: boolean
	loadSteps: LoadSteps
	loadFootprint: LoadFootprint
}) {
	return (
		<>
			<div className="page-head">
				<h1>
					<StatusMarkInline status={run.status} />
					<span>Run {run.id.slice(0, 8)}</span>
				</h1>
				<div className="subtitle">
					{run.branch && <span className="chip">{run.branch}</span>}
					{run.tier && <span className="chip" title="The tier this run selected (OPICE_TIER)">tier: {run.tier}</span>}
					{run.commitSha && (
						<>
							<span className="sep">·</span>
							<span>commit <code>{run.commitSha.slice(0, 7)}</code></span>
						</>
					)}
					<span className="sep">·</span>
					<span title={fmtDate(run.startedAt)}>started {fmtRelative(run.startedAt)}</span>
					{run.finishedAt && (
						<>
							<span className="sep">·</span>
							<span className="tabular">{fmtDuration(run.finishedAt - run.startedAt)}</span>
						</>
					)}
					{!!run.skippedScenarios && (
						<>
							<span className="sep">·</span>
							<span className="tabular">{run.skippedScenarios} skipped</span>
						</>
					)}
				</div>
			</div>

			{scenariosLoading ? (
				<Loading message="Loading scenarios…" />
			) : !scenarios || scenarios.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No scenarios reported</div>
				</div>
			) : (
				<Workbench scenarios={scenarios} loadSteps={loadSteps} loadFootprint={loadFootprint} />
			)}
		</>
	)
}

/**
 * Master/detail browser for a run's scenarios: filter tabs + search across the
 * top, a feature-grouped scenario list on the left, and the selected scenario's
 * metadata + steps on the right. Steps are fetched lazily for the *selected*
 * scenario only — the list stands on the scenario-level status the run already
 * carries, so opening a run doesn't fan out one steps query per scenario.
 */
function Workbench({
	scenarios,
	loadSteps,
	loadFootprint,
}: {
	scenarios: Scenario[]
	loadSteps: LoadSteps
	loadFootprint: LoadFootprint
}) {
	const [filter, setFilter] = useState<ScenarioStatus | 'all'>('all')
	const [query, setQuery] = useState('')
	const [selectedId, setSelectedId] = useState<string | null>(null)

	const counts = useMemo(() => {
		const c: Record<string, number> = {}
		for (const s of scenarios) c[s.status] = (c[s.status] ?? 0) + 1
		return c
	}, [scenarios])

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase()
		return scenarios.filter(s => {
			if (filter !== 'all' && s.status !== filter) return false
			if (q && !s.name.toLowerCase().includes(q) && !(s.feature ?? '').toLowerCase().includes(q)) {
				return false
			}
			return true
		})
	}, [scenarios, filter, query])

	// A feature only earns a header band when it covers more than one row.
	// Single-scenario features and no-feature scenarios collapse into a flat
	// "loose" tail (each carrying an inline feature chip). Everything sorts by
	// severity (failures first), features tie-breaking alphabetically; loose
	// no-feature rows sink last within their severity.
	const { groups, loose } = useMemo(() => {
		const sev = (s: Scenario) => SEVERITY[s.status]
		const byFeature = new Map<string, Scenario[]>()
		const loose: Scenario[] = []
		for (const s of filtered) {
			if (!s.feature) {
				loose.push(s)
				continue
			}
			const list = byFeature.get(s.feature)
			if (list) list.push(s)
			else byFeature.set(s.feature, [s])
		}

		const groups: { feature: string; items: Scenario[]; sev: number }[] = []
		for (const [feature, items] of byFeature) {
			if (items.length < 2) {
				loose.push(items[0]!)
				continue
			}
			items.sort((a, b) => sev(a) - sev(b))
			groups.push({ feature, items, sev: sev(items[0]!) })
		}

		groups.sort((a, b) => a.sev - b.sev || a.feature.localeCompare(b.feature))
		loose.sort(
			(a, b) => sev(a) - sev(b) || (a.feature ?? '￿').localeCompare(b.feature ?? '￿'),
		)
		return { groups, loose }
	}, [filtered])

	// Keep a valid selection: when the current pick falls out of the filter,
	// jump to the first problem scenario (failed > warning > incomplete), else
	// the first row in view.
	useEffect(() => {
		if (filtered.length === 0) {
			setSelectedId(null)
			return
		}
		if (selectedId && filtered.some(s => s.id === selectedId)) return
		const firstBad =
			filtered.find(s => s.status === 'failed') ??
			filtered.find(s => s.status === 'warning' || s.status === 'incomplete')
		setSelectedId((firstBad ?? filtered[0]!).id)
	}, [filtered, selectedId])

	const selected = scenarios.find(s => s.id === selectedId) ?? null

	return (
		<div className="workbench">
			<div className="wb-bar">
				<div className="wb-tabs">
					<button
						type="button"
						className={`wb-tab${filter === 'all' ? ' active' : ''}`}
						onClick={() => setFilter('all')}
					>
						All <span className="wb-tab-count">{scenarios.length}</span>
					</button>
					{FILTER_ORDER.filter(st => counts[st]).map(st => (
						<button
							key={st}
							type="button"
							className={`wb-tab${filter === st ? ' active' : ''}`}
							onClick={() => setFilter(st)}
						>
							<StatusMark status={st} className="mini" />
							{FILTER_LABEL[st]} <span className="wb-tab-count">{counts[st]}</span>
						</button>
					))}
				</div>
				<input
					className="wb-search"
					type="search"
					placeholder="Search scenarios…"
					value={query}
					onChange={e => setQuery(e.target.value)}
				/>
			</div>

			<div className="wb-body">
				<div className="wb-list">
					{filtered.length === 0 ? (
						<div className="wb-list-empty">No scenarios match.</div>
					) : (
						<>
							{groups.map(({ feature, items }) => (
								<div className="wb-group" key={feature}>
									<div className="wb-group-head">{feature}</div>
									{items.map(s => (
										<ScenarioRow key={s.id} s={s} selectedId={selectedId} onSelect={setSelectedId} />
									))}
								</div>
							))}
							{loose.length > 0 && (
								<div className="wb-loose">
									{loose.map(s => (
										<ScenarioRow key={s.id} s={s} selectedId={selectedId} onSelect={setSelectedId} showFeature />
									))}
								</div>
							)}
						</>
					)}
				</div>

				<div className="wb-detail">
					{selected ? (
						<ScenarioDetail scenario={selected} loadSteps={loadSteps} loadFootprint={loadFootprint} />
					) : (
						<div className="wb-detail-empty">Select a scenario.</div>
					)}
				</div>
			</div>
		</div>
	)
}

/**
 * A single scenario row in the master list. `showFeature` draws the feature ID
 * as an inline chip — used for the loose tail, where there's no header to carry
 * it (headed groups already name their feature).
 */
function ScenarioRow({
	s,
	selectedId,
	onSelect,
	showFeature,
}: {
	s: Scenario
	selectedId: string | null
	onSelect: (id: string) => void
	showFeature?: boolean
}) {
	return (
		<button
			type="button"
			className={`wb-item${s.id === selectedId ? ' active' : ''}`}
			onClick={() => onSelect(s.id)}
		>
			<StatusMark status={s.status} className="mini" />
			<span className="wb-item-name">{s.name}</span>
			{isFlaky(s) && <span className="flaky-badge" title={`Passed after ${s.attempts} attempts`}>flaky</span>}
			{showFeature && s.feature && <span className="wb-item-feature">{s.feature}</span>}
			<span className="wb-item-dur tabular">{fmtDuration(s.durationMs)}</span>
		</button>
	)
}

function ScenarioDetail({
	scenario: s,
	loadSteps,
	loadFootprint,
}: {
	scenario: Scenario
	loadSteps: LoadSteps
	loadFootprint: LoadFootprint
}) {
	const skipped = s.status === 'skipped'
	const steps = useQuery({
		queryKey: ['scenarios.steps', s.id],
		queryFn: () => loadSteps(s.id),
		// A skipped scenario never ran, so it has no steps — don't fetch.
		enabled: !skipped,
	})
	// The blob is fetched only when the scenario actually has one — the summary on
	// the row is what tells us, so browsing a run of footprint-less scenarios
	// costs no requests at all.
	const footprint = useQuery({
		queryKey: ['scenarios.footprint', s.id],
		queryFn: () => loadFootprint(s.id),
		enabled: !skipped && !!s.footprint,
	})

	// Requests, bucketed by the step that was active when they started. Built
	// once here rather than filtered per step, so a scenario with hundreds of
	// requests doesn't turn the step list into a quadratic scan.
	const requestsByStep = useMemo(() => {
		const map = new Map<number, FootprintRequest[]>()
		for (const request of footprint.data?.requests ?? []) {
			if (request.step === null) continue
			const list = map.get(request.step)
			if (list) list.push(request)
			else map.set(request.step, [request])
		}
		return map
	}, [footprint.data])

	// Tier is only worth a chip when it diverges from the default 'standard' —
	// otherwise every scenario would carry a redundant 'standard' tag.
	const showTier = !!s.tier && s.tier !== 'standard'
	const hasMeta = !!s.feature || showTier || s.seeds.length > 0 || s.roles.length > 0

	return (
		<>
			<div className="wb-detail-bar">
				<StatusMarkInline status={s.status} />
				{isFlaky(s) && <span className="flaky-badge" title={`Passed after ${s.attempts} attempts`}>flaky · {s.attempts}×</span>}
				{s.hash && <span className="hash">#{s.hash}</span>}
				<span className="pull" />
				{!skipped && (
					<span className="wb-detail-dur">
						<ClockIcon className="icon" />
						<span className="tabular">{fmtDuration(s.durationMs)}</span>
					</span>
				)}
			</div>

			<h2 className="wb-detail-title">{s.name}</h2>

			{hasMeta && (
				<div className="s-meta">
					{s.feature && <span className="meta-chip feature" title="Feature / requirement">{s.feature}</span>}
					{showTier && <span className="meta-chip tier" title="Test tier — when this scenario runs">{s.tier}</span>}
					{s.seeds.map(x => <span key={`seed-${x}`} className="meta-chip seed" title="Required seed">{x}</span>)}
					{s.roles.map(x => <span key={`role-${x}`} className="meta-chip role" title="Acting role">{x}</span>)}
				</div>
			)}

			{!skipped && s.footprint && (
				<FootprintPanel summary={s.footprint} detail={footprint.data ?? null} loading={footprint.isLoading} />
			)}

			{!skipped && s.videoUrl && (
				<div className="s-video">
					{/* Walkthrough recording (opt-in OPICE_VIDEO) — great for tutorials. */}
					<video className="s-video-player" src={s.videoUrl} controls preload="metadata" />
				</div>
			)}

			{skipped ? (
				<div className="wb-skip-note">
					Skipped — {s.skipReason ?? 'excluded by the run’s tier filter'}. This scenario was not executed.
				</div>
			) : steps.isLoading ? (
				<Loading message="Loading steps…" />
			) : !steps.data || steps.data.length === 0 ? (
				<div className="muted" style={{ padding: '12px 0', fontSize: 12.5 }}>No steps recorded.</div>
			) : (
				<div className="steps">
					{steps.data.map(st => <StepRow key={st.id} step={st} requests={requestsByStep.get(st.sequence)} />)}
				</div>
			)}

			{s.testFile && (
				<div className="wb-detail-source">
					<code>{s.testFile}</code>
				</div>
			)}
		</>
	)
}

/**
 * What the scenario touched (opt-in OPICE_FOOTPRINT).
 *
 * The counts come free with the scenario row, so the header renders instantly;
 * each dimension's detail lives in a blob fetched on demand. Models lead,
 * because "this scenario writes Invoice" is the fact that changes what you do
 * next — a written model is the strongest claim in here, and it's marked as such.
 */
function FootprintPanel({
	summary,
	detail,
	loading,
}: {
	summary: FootprintSummary
	detail: FootprintDetail | null
	loading: boolean
}) {
	const written = detail?.models.filter(m => m.write) ?? []
	const read = detail?.models.filter(m => !m.write) ?? []
	return (
		<div className="s-footprint">
			<div className="s-footprint-head">
				<span className="s-footprint-title">Touches</span>
				{summary.models > 0 && <span className="fp-count">{summary.models} models</span>}
				{summary.endpoints > 0 && <span className="fp-count">{summary.endpoints} endpoints</span>}
				{summary.files > 0 && <span className="fp-count">{summary.files} files</span>}
				{summary.components > 0 && <span className="fp-count">{summary.components} components</span>}
				{loading && <span className="fp-count muted">loading…</span>}
			</div>

			{detail && (
				<>
					{detail.models.length > 0 && (
						<div className="fp-row">
							{written.map(m => (
								<span key={`w-${m.name}`} className="fp-chip model write" title="Written — reached through a mutation">{m.name}</span>
							))}
							{read.map(m => (
								<span key={`r-${m.name}`} className="fp-chip model" title="Read only">{m.name}</span>
							))}
						</div>
					)}

					{detail.endpoints.length > 0 && (
						<FootprintList label={`Endpoints (${detail.endpoints.length})`}>
							{() => detail.endpoints.map(e => (
								<div className="fp-line" key={e.route}>
									<span className="fp-method">{e.methods.join('/')}</span>
									<code>{e.route}</code>
									{e.count > 1 && <span className="fp-times">×{e.count}</span>}
								</div>
							))}
						</FootprintList>
					)}

					{detail.components.length > 0 && (
						<FootprintList label={`Components (${detail.components.length})`}>
							{() => (
								<div className="fp-row">
									{detail.components.map(c => <span key={c} className="fp-chip">{c}</span>)}
								</div>
							)}
						</FootprintList>
					)}

					{detail.files.length > 0 && (
						<FootprintList label={`Files (${detail.files.length})`}>
							{() => detail.files.map(f => (
								<div className="fp-line" key={f.path}>
									<code>{f.path}</code>
									{/* Inferred from the repo, not measured in the page — worth saying so. */}
									{f.source === 'plugin' && (
										<span className="fp-times" title="Named by a footprint plugin from the request, not observed in the browser">via plugin</span>
									)}
									{typeof f.executed === 'number' && (
										<span className="fp-times" title="Share of the file V8 saw execute">{Math.round(f.executed * 100)}%</span>
									)}
								</div>
							))}
						</FootprintList>
					)}

					{detail.warnings && detail.warnings.length > 0 && (
						<div className="fp-warnings">
							{/* A thin footprint should look thin, not quietly wrong. */}
							{detail.warnings.map(w => <div className="fp-warning" key={w}>{w}</div>)}
						</div>
					)}
				</>
			)}
		</div>
	)
}

/**
 * A collapsed dimension of the footprint. `children` is a thunk so a closed
 * section costs nothing: a scenario can carry thousands of files, and mounting
 * every row to show a summary line would build tens of thousands of DOM nodes
 * inside a 260px scroll box nobody has opened.
 */
function FootprintList({ label, children }: { label: string; children: () => React.ReactNode }) {
	const [open, setOpen] = useState(false)
	return (
		<details className="fp-details" onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
			<summary>{label}</summary>
			{open && <div className="fp-details-body">{children()}</div>}
		</details>
	)
}

/** The API calls one step made, listed under it. */
function StepRequests({ requests }: { requests: FootprintRequest[] }) {
	return (
		<div className="step-requests">
			{requests.map((r, i) => {
				const operations = r.operations ?? []
				return (
					<div className="step-request" key={`${r.method}-${r.route}-${i}`}>
						<span className="fp-method">{r.method}</span>
						<code>{r.route}</code>
						{operations.length > 0 && (
							<span className="step-request-ops">
								{operations.map(o => o.name ?? o.rootFields.join(', ')).join(' · ')}
							</span>
						)}
						{r.status !== null && (
							<span className={`step-request-status${r.status >= 400 ? ' bad' : ''}`}>{r.status}</span>
						)}
						{r.durationMs !== null && <span className="duration tabular">{fmtDuration(r.durationMs)}</span>}
					</div>
				)
			})}
		</div>
	)
}

function StepRow({ step: st, requests }: { step: Step; requests?: FootprintRequest[] }) {
	// A pending step with a reason is 'blocked' (feature not built); without, a
	// plain todo awaiting authoring.
	const blocked = st.status === 'pending' && !!st.reason
	const display = blocked ? 'blocked' : st.status
	return (
		<div className={`step${st.kind === 'invariant' ? ' invariant' : ''}${st.status === 'pending' ? ' pending' : ''}${blocked ? ' blocked' : ''}`}>
			<span className="step-mark"><StatusMark status={display} className="mini" /></span>
			<span className="step-name">
				{st.kind === 'invariant' && <span className="step-kind" title="Scenario-level acceptance">invariant</span>}
				{st.name}
			</span>
			<span className="duration">{st.status === 'pending' ? (blocked ? 'blocked' : 'not authored') : fmtDuration(st.durationMs)}</span>
			{(st.intent || st.error || st.reason || st.screenshotUrl || st.screenshotFailed || requests?.length) && (
				<div className="step-detail">
					{st.intent && <div className="step-intent">{st.intent}</div>}
					{requests && requests.length > 0 && <StepRequests requests={requests} />}
					{st.reason && (
						<div className="step-reason">
							{blocked ? 'Blocked' : st.status === 'fixmepass' ? 'Marked fixme but passed' : 'Known failure'} — {st.reason}
						</div>
					)}
					{st.error && <div className="step-error">{st.error}</div>}
					{st.screenshotUrl && <Polaroid src={st.screenshotUrl} caption={st.name} />}
					{!st.screenshotUrl && st.screenshotFailed && (
						<div className="step-screenshot-failed" title="A screenshot was captured but its upload to storage failed (transient R2 error).">
							screenshot upload failed
						</div>
					)}
				</div>
			)}
		</div>
	)
}
