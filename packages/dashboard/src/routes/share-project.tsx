import { createPage, Link } from '@buzola/router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { fmtDuration, fmtRelative } from '../lib/format'
import { CalendarIcon, ClockIcon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { StatusMark } from '../components/StatusBadge'
import { shareRpc } from '../lib/share-client'

const PAGE_SIZE = 50

export default createPage()
	.params({ slug: 'string' })
	.route('/s/p/:slug')
	.render(({ params }) => <ShareProjectPage slug={params.slug} />)

/**
 * The anonymous, read-only share view of a whole PROJECT — its run list.
 * Everything goes through the share RPC client (`/s/rpc`), never the operator
 * `/rpc` surface, so it works for a visitor with no Cloudflare Access session,
 * only a redeemed read cookie. Each run links to the matching share run view
 * (`/s/p/:slug/r/:runId`), NOT the Access-gated operator path.
 *
 * Browsing a run list needs a PROJECT-scoped read capability. A single
 * run-share link can't list runs — `runs.listForProject` 404/403s — so that
 * case renders a graceful note instead of crashing, mirroring `share-run.tsx`.
 */
function ShareProjectPage({ slug }: { slug: string }) {
	const project = useQuery({
		queryKey: ['share.projects.get', slug],
		queryFn: () => shareRpc.projects.get({ slug }),
	})
	const runs = useQuery({
		queryKey: ['share.runs.listForProject', slug],
		queryFn: () => shareRpc.runs.listForProject({ projectSlug: slug, limit: PAGE_SIZE, offset: 0 }),
		enabled: project.isSuccess,
		placeholderData: keepPreviousData,
	})

	if (project.error) {
		return <div className="error">{(project.error as Error).message}</div>
	}
	if (!project.data) {
		return <Loading />
	}

	const items = runs.data?.runs ?? []

	return (
		<>
			<div className="breadcrumb">
				<span>{project.data.name}</span>
			</div>

			<div className="page-head">
				<h1>{project.data.name}</h1>
				<div className="subtitle">
					<code>{project.data.slug}</code>
					<span className="sep">·</span>
					<span>shared, read-only</span>
				</div>
			</div>

			{runs.isLoading ? (
				<Loading message="Loading runs…" />
			) : runs.error ? (
				// A run-scoped link can't browse the run list — say so plainly rather
				// than crash. Operate the actual run via its own share link.
				<div className="empty">
					<div className="empty-title">This link only grants access to a single run</div>
					<div className="empty-body">Open the run link you were given to view that run.</div>
				</div>
			) : items.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No runs yet</div>
				</div>
			) : (
				<div className="entry-list">
					{items.map(r => (
						<ShareRunEntry key={r.id} run={r} slug={slug} />
					))}
				</div>
			)}
		</>
	)
}

interface RunRow {
	id: string
	branch: string | null
	commitSha: string | null
	status: 'running' | 'passed' | 'failed' | 'incomplete' | 'warning'
	source: 'ci' | 'local' | null
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	warningScenarios: number
	incompleteScenarios: number
	startedAt: number
	finishedAt: number | null
}

/**
 * One run row in the share project view. Mirrors the operator `RunEntry`
 * markup, but links to the share run path (`/s/p/:slug/r/:runId`) via the
 * `share-run` route rather than the Access-gated operator `projects/run` route.
 */
function ShareRunEntry({ run: r, slug }: { run: RunRow; slug: string }) {
	const duration = r.finishedAt ? r.finishedAt - r.startedAt : null
	return (
		<div className="entry" data-testid="share-run-row">
			<span className="e-status">
				<StatusMark status={r.status} />
			</span>
			<div className="e-body">
				<div className="e-title">
					<Link to="share-run" params={{ slug, runId: r.id }}>
						Run {r.id.slice(0, 8)}
						{r.commitSha && (
							<> · <span style={{ fontWeight: 400, color: 'var(--text-soft)' }}>commit {r.commitSha.slice(0, 7)}</span></>
						)}
					</Link>
				</div>
				<div className="e-meta">
					<span><strong className="tabular">{r.passedScenarios}</strong> passed</span>
					{r.failedScenarios > 0 && (
						<>
							<span className="sep">·</span>
							<span style={{ color: 'var(--fail)' }}><strong className="tabular" style={{ color: 'var(--fail)' }}>{r.failedScenarios}</strong> failed</span>
						</>
					)}
					{r.warningScenarios > 0 && (
						<>
							<span className="sep">·</span>
							<span style={{ color: 'var(--run)' }}><strong className="tabular" style={{ color: 'var(--run)' }}>{r.warningScenarios}</strong> warning</span>
						</>
					)}
					{r.incompleteScenarios > 0 && (
						<>
							<span className="sep">·</span>
							<span style={{ color: 'var(--text-soft)' }}><strong className="tabular" style={{ color: 'var(--text-soft)' }}>{r.incompleteScenarios}</strong> incomplete</span>
						</>
					)}
					<span className="sep">·</span>
					<span><strong className="tabular">{r.totalScenarios}</strong> total</span>
				</div>
			</div>
			{r.source === 'local' && <span className="e-chip chip chip-local" title="Reported from a local dev run">local</span>}
			{r.branch && <span className="e-chip chip">{r.branch}</span>}
			<div className="e-aside">
				<span className="row">
					<CalendarIcon className="icon" />
					<span>{fmtRelative(r.startedAt)}</span>
				</span>
				<span className="row">
					<ClockIcon className="icon" />
					<span className="tabular">{fmtDuration(duration)}</span>
				</span>
			</div>
		</div>
	)
}
