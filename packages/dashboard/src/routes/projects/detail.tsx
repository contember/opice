import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../../components/EmptyState'
import { CalendarIcon, ClockIcon, InboxIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { StatusMark } from '../../components/StatusBadge'
import { rpc } from '../../lib/client'
import { fmtDuration, fmtRelative } from '../../lib/format'

export default createPage()
	.params({ slug: 'string' })
	.route('/p/:slug')
	.render(({ params }) => <ProjectPage slug={params.slug} />)

function ProjectPage({ slug }: { slug: string }) {
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const runs = useQuery({
		queryKey: ['runs.listForProject', slug],
		queryFn: () => rpc.runs.listForProject({ projectSlug: slug, limit: 50 }),
		enabled: project.isSuccess,
	})

	if (project.isLoading) return <Loading message="Loading project…" />
	if (project.error) return <div className="error">{(project.error as Error).message}</div>
	if (!project.data) return null

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<span>{project.data.name}</span>
			</div>

			<div className="page-head">
				<h1>{project.data.name}</h1>
				<div className="subtitle">
					<code>{project.data.slug}</code>
					<span className="sep">·</span>
					<span>added {fmtRelative(project.data.createdAt)}</span>
				</div>
			</div>

			{runs.isLoading ? (
				<Loading message="Loading runs…" />
			) : !runs.data || runs.data.length === 0 ? (
				<EmptyState
					icon={<InboxIcon size={32} />}
					title="No runs yet"
				>
					Wire <code>OPICE_PROJECT</code>, <code>OPICE_API_KEY</code> and{' '}
					<code>OPICE_ENDPOINT</code> in your CI to start streaming runs.
				</EmptyState>
			) : (
				<>
					<div className="toolbar">
						<span className="total">{runs.data.length} {runs.data.length === 1 ? 'run' : 'runs'}</span>
						<span className="pull" />
						<span className="filter">Status<span className="caret">▾</span></span>
						<span className="filter">Branch<span className="caret">▾</span></span>
						<span className="filter">Commit<span className="caret">▾</span></span>
					</div>
					<div className="entry-list has-toolbar">
						{runs.data.map((r, i) => {
							const duration = r.finishedAt ? r.finishedAt - r.startedAt : null
							const num = runs.data.length - i
							return (
								<div className="entry" key={r.id}>
									<span className="e-status">
										<StatusMark status={r.status} />
									</span>
									<div className="e-body">
										<div className="e-title">
											<Link to="projects/run" params={{ slug, runId: r.id }}>
												Run #{num}
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
						})}
					</div>
				</>
			)}
		</>
	)
}
