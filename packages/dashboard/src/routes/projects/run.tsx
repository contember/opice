import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { ClockIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { Polaroid } from '../../components/Polaroid'
import { StatusMark, StatusMarkInline } from '../../components/StatusBadge'
import { useSession } from '../../lib/auth-client'
import { rpc } from '../../lib/client'
import { fmtDate, fmtDuration, fmtRelative } from '../../lib/format'

export default createPage()
	.params({ slug: 'string', runId: 'string' })
	.route('/p/:slug/r/:runId')
	.render(({ params }) => <RunPage slug={params.slug} runId={params.runId} />)

type ScenarioStatus = 'running' | 'passed' | 'failed' | 'warning' | 'incomplete'

interface Scenario {
	id: string
	name: string
	status: ScenarioStatus
	hash: string | null
	testFile: string | null
	feature: string | null
	seeds: string[]
	roles: string[]
	durationMs: number | null
	attempts: number
}

// A passed scenario that needed more than one attempt is flaky — it failed at
// least once before passing within the retry budget.
const isFlaky = (s: Scenario): boolean => s.status === 'passed' && s.attempts > 1

// Filter tabs, surfacing problems first. 'all' is always present; the rest only
// render when the run actually carries scenarios in that state.
const FILTER_ORDER: ScenarioStatus[] = ['failed', 'warning', 'incomplete', 'running', 'passed']
const FILTER_LABEL: Record<ScenarioStatus, string> = {
	failed: 'Failed',
	warning: 'Warnings',
	incomplete: 'Incomplete',
	running: 'Running',
	passed: 'Passed',
}

// Triage order: broken first, passing last. Used to sort both feature groups
// (by their worst scenario) and the rows within them, so the eye and the
// auto-selection land on the same place.
const SEVERITY: Record<ScenarioStatus, number> = {
	failed: 0,
	warning: 1,
	incomplete: 2,
	running: 3,
	passed: 4,
}

function RunPage({ slug, runId }: { slug: string; runId: string }) {
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const run = useQuery({
		queryKey: ['runs.get', runId],
		queryFn: () => rpc.runs.get({ runId }),
	})
	const scenarios = useQuery({
		queryKey: ['runs.scenarios', runId],
		queryFn: () => rpc.runs.scenarios({ runId }),
	})

	if (project.error || run.error) {
		return <div className="error">{((project.error ?? run.error) as Error).message}</div>
	}
	if (!project.data || !run.data) {
		return <Loading />
	}

	const r = run.data

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<Link to="projects/detail" params={{ slug }}>{project.data.name}</Link>
				<span className="sep">/</span>
				<span>Run {r.id.slice(0, 8)}</span>
			</div>

			<div className="page-head">
				<h1>
					<StatusMarkInline status={r.status} />
					<span>Run {r.id.slice(0, 8)}</span>
				</h1>
				<div className="subtitle">
					{r.branch && <span className="chip">{r.branch}</span>}
					{r.commitSha && (
						<>
							<span className="sep">·</span>
							<span>commit <code>{r.commitSha.slice(0, 7)}</code></span>
						</>
					)}
					<span className="sep">·</span>
					<span title={fmtDate(r.startedAt)}>started {fmtRelative(r.startedAt)}</span>
					{r.finishedAt && (
						<>
							<span className="sep">·</span>
							<span className="tabular">{fmtDuration(r.finishedAt - r.startedAt)}</span>
						</>
					)}
				</div>
			</div>

			{scenarios.isLoading ? (
				<Loading message="Loading scenarios…" />
			) : !scenarios.data || scenarios.data.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No scenarios reported</div>
				</div>
			) : (
				<Workbench scenarios={scenarios.data} />
			)}

			<ShareManager slug={slug} runId={r.id} />
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
function Workbench({ scenarios }: { scenarios: Scenario[] }) {
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
						<ScenarioDetail scenario={selected} />
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

function ScenarioDetail({ scenario: s }: { scenario: Scenario }) {
	const steps = useQuery({
		queryKey: ['scenarios.steps', s.id],
		queryFn: () => rpc.scenarios.steps({ scenarioId: s.id }),
	})

	const hasMeta = !!s.feature || s.seeds.length > 0 || s.roles.length > 0

	return (
		<>
			<div className="wb-detail-bar">
				<StatusMarkInline status={s.status} />
				{isFlaky(s) && <span className="flaky-badge" title={`Passed after ${s.attempts} attempts`}>flaky · {s.attempts}×</span>}
				{s.hash && <span className="hash">#{s.hash}</span>}
				<span className="pull" />
				<span className="wb-detail-dur">
					<ClockIcon className="icon" />
					<span className="tabular">{fmtDuration(s.durationMs)}</span>
				</span>
			</div>

			<h2 className="wb-detail-title">{s.name}</h2>

			{hasMeta && (
				<div className="s-meta">
					{s.feature && <span className="meta-chip feature" title="Feature / requirement">{s.feature}</span>}
					{s.seeds.map(x => <span key={`seed-${x}`} className="meta-chip seed" title="Required seed">{x}</span>)}
					{s.roles.map(x => <span key={`role-${x}`} className="meta-chip role" title="Acting role">{x}</span>)}
				</div>
			)}

			{steps.isLoading ? (
				<Loading message="Loading steps…" />
			) : !steps.data || steps.data.length === 0 ? (
				<div className="muted" style={{ padding: '12px 0', fontSize: 12.5 }}>No steps recorded.</div>
			) : (
				<div className="steps">
					{steps.data.map(st => <StepRow key={st.id} step={st} />)}
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

interface Step {
	id: number
	kind: 'step' | 'invariant'
	name: string
	status: 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
	durationMs: number
	error: string | null
	intent: string | null
	reason: string | null
	screenshotUrl: string | null
}

function StepRow({ step: st }: { step: Step }) {
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
			{(st.intent || st.error || st.reason || st.screenshotUrl) && (
				<div className="step-detail">
					{st.intent && <div className="step-intent">{st.intent}</div>}
					{st.reason && (
						<div className="step-reason">
							{blocked ? 'Blocked' : st.status === 'fixmepass' ? 'Marked fixme but passed' : 'Known failure'} — {st.reason}
						</div>
					)}
					{st.error && <div className="step-error">{st.error}</div>}
					{st.screenshotUrl && <Polaroid src={st.screenshotUrl} caption={st.name} />}
				</div>
			)}
		</div>
	)
}

/**
 * Operator-only share management. Mints/lists/revokes read-only links scoped to
 * *this run* (a `read` token with `run_id` set). Hidden for share-link visitors
 * (no session) — they already arrived via such a link, and the `shares.*` RPCs
 * require the `write` capability they don't have.
 */
function ShareManager({ slug, runId }: { slug: string; runId: string }) {
	const { data: session } = useSession()
	const queryClient = useQueryClient()
	const origin = typeof window !== 'undefined' ? window.location.origin : ''
	const [minted, setMinted] = useState<string | null>(null)

	const shares = useQuery({
		queryKey: ['shares.list', runId],
		queryFn: () => rpc.shares.list({ runId }),
		enabled: !!session,
	})

	const create = useMutation({
		mutationFn: () => rpc.shares.create({ runId }),
		onSuccess: ({ token }) => {
			setMinted(`${origin}/p/${slug}/r/${runId}?token=${token}`)
			queryClient.invalidateQueries({ queryKey: ['shares.list', runId] })
		},
	})

	const revoke = useMutation({
		mutationFn: (tokenId: string) => rpc.shares.revoke({ tokenId }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares.list', runId] }),
	})

	// Share-link visitors (no session) don't manage shares.
	if (!session) return null

	return (
		<div className="share-link">
			<div className="share-head">
				<span className="share-label">Read-only links</span>
				<button type="button" className="share-copy" onClick={() => create.mutate()} disabled={create.isPending}>
					{create.isPending ? 'Creating…' : '+ Create link'}
				</button>
			</div>

			{minted && (
				<div className="share-minted">
					<CopyUrl url={minted} />
					<span className="share-hint">Shown once — copy it now. It grants read-only access to this run only.</span>
				</div>
			)}

			{shares.data && shares.data.length > 0 ? (
				<ul className="share-list">
					{shares.data.map((s) => (
						<li key={s.id} className="share-row">
							<code className="share-id">{s.id.slice(0, 8)}…</code>
							<span className="share-meta">
								{s.expiresAt ? `expires ${fmtRelative(s.expiresAt)}` : 'no expiry'}
								{s.lastUsedAt ? ` · used ${fmtRelative(s.lastUsedAt)}` : ' · never used'}
							</span>
							<button
								type="button"
								className="share-copy"
								onClick={() => revoke.mutate(s.id)}
								disabled={revoke.isPending}
							>
								Revoke
							</button>
						</li>
					))}
				</ul>
			) : (
				<span className="share-hint">No active share links. Anyone with a link can view this run read-only.</span>
			)}
		</div>
	)
}

function CopyUrl({ url }: { url: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () => {
		void navigator.clipboard.writeText(url).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}
	return (
		<div className="share-copy-row">
			<code className="share-url">{url}</code>
			<button type="button" className="share-copy" onClick={copy}>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</div>
	)
}
