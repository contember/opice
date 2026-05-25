import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ChevronIcon, ClockIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { Polaroid } from '../../components/Polaroid'
import { ResultStrip } from '../../components/Stat'
import { StatusMark, StatusMarkInline } from '../../components/StatusBadge'
import { useSession } from '../../lib/auth-client'
import { rpc } from '../../lib/client'
import { fmtDate, fmtDuration, fmtRelative } from '../../lib/format'

export default createPage()
	.params({ slug: 'string', runId: 'string' })
	.route('/p/:slug/r/:runId')
	.render(({ params }) => <RunPage slug={params.slug} runId={params.runId} />)

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
				</div>
			</div>

			<ResultStrip run={r} />

			<ShareManager slug={slug} runId={r.id} />

			<div className="section-head">
				<span className="label">Scenarios</span>
				<span className="count">{scenarios.data?.length ?? 0}</span>
			</div>

			{scenarios.isLoading ? (
				<Loading message="Loading scenarios…" />
			) : !scenarios.data || scenarios.data.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No scenarios reported</div>
				</div>
			) : (
				<div className="scenarios">
					{scenarios.data.map((s, i) => (
						<ScenarioBlock
							key={s.id}
							index={i + 1}
							scenarioId={s.id}
							name={s.name}
							status={s.status}
							hash={s.hash}
							durationMs={s.durationMs}
						/>
					))}
				</div>
			)}
		</>
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

interface ScenarioProps {
	index: number
	scenarioId: string
	name: string
	status: 'running' | 'passed' | 'failed' | 'warning'
	hash: string | null
	durationMs: number | null
}

function ScenarioBlock({ index, scenarioId, name, status, hash, durationMs }: ScenarioProps) {
	const steps = useQuery({
		queryKey: ['scenarios.steps', scenarioId],
		queryFn: () => rpc.scenarios.steps({ scenarioId }),
	})

	const failedCount = steps.data?.filter(s => s.status === 'failed').length ?? 0
	const fixmeCount = steps.data?.filter(s => s.status === 'fixme' || s.status === 'fixmepass').length ?? 0

	return (
		<details className="scenario" open={status === 'failed' || status === 'warning'}>
			<summary>
				<ChevronIcon className="chevron" />
				<StatusMark status={status} />
				<span className="s-num">#{String(index).padStart(2, '0')}</span>
				<span className="s-name">{name}</span>
				<span className="s-aside">
					{steps.data && steps.data.length > 0 && (
						<span>
							{steps.data.length} {steps.data.length === 1 ? 'step' : 'steps'}
							{failedCount > 0 && (
								<span style={{ color: 'var(--fail)' }}> · {failedCount} failed</span>
							)}
							{fixmeCount > 0 && (
								<span style={{ color: 'var(--run)' }}> · {fixmeCount} known</span>
							)}
						</span>
					)}
					{hash && <span className="hash">#{hash}</span>}
					<span className="duration">
						<ClockIcon className="icon" />
						<span className="tabular">{fmtDuration(durationMs)}</span>
					</span>
				</span>
			</summary>
			{steps.isLoading ? (
				<div className="steps"><Loading message="Loading steps…" /></div>
			) : !steps.data || steps.data.length === 0 ? (
				<div className="steps">
					<div className="muted" style={{ padding: '12px 16px', fontSize: 12.5 }}>
						No steps recorded.
					</div>
				</div>
			) : (
				<div className="steps">
					{steps.data.map(st => (
						<div className="step" key={st.id}>
							<span className="step-mark"><StatusMark status={st.status} className="mini" /></span>
							<span className="step-name">{st.name}</span>
							<span className="duration">{fmtDuration(st.durationMs)}</span>
							{(st.error || st.reason || st.screenshotUrl) && (
								<div className="step-detail">
									{st.reason && (
										<div className="step-reason">
											{st.status === 'fixmepass' ? 'Marked fixme but passed' : 'Known failure'} — {st.reason}
										</div>
									)}
									{st.error && <div className="step-error">{st.error}</div>}
									{st.screenshotUrl && <Polaroid src={st.screenshotUrl} caption={st.name} />}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</details>
	)
}
