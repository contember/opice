import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../../components/EmptyState'
import { InboxIcon } from '../../components/Icon'
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
				<Link to="index">Registry</Link>
				<span className="sep">/</span>
				<span>{project.data.name}</span>
			</div>

			<div className="page-head">
				<div className="eyebrow">Subject</div>
				<h1>{project.data.name}</h1>
				<div className="subtitle">
					<code>{project.data.slug}</code>
					<span className="sep">·</span>
					<span>added {fmtRelative(project.data.createdAt)}</span>
				</div>
			</div>

			<div className="section-head">
				<span className="label">Observation log</span>
				<span className="rule" />
			</div>

			{runs.isLoading ? (
				<Loading message="Reading runs…" />
			) : !runs.data || runs.data.length === 0 ? (
				<EmptyState
					icon={<InboxIcon size={36} />}
					title="No observations yet"
				>
					Wire <code>OPICE_PROJECT</code>, <code>OPICE_API_KEY</code> and{' '}
					<code>OPICE_ENDPOINT</code> in your CI to begin streaming runs.
				</EmptyState>
			) : (
				<div className="entry-list">
					{runs.data.map(r => {
						const duration = r.finishedAt ? r.finishedAt - r.startedAt : null
						return (
							<div className="entry" key={r.id}>
								<div className="entry-gutter">
									<StatusMark status={r.status} />
									<span className="gutter-time">{fmtRelative(r.startedAt)}</span>
								</div>
								<div className="entry-body">
									<div className="lead">
										<Link to="projects/run" params={{ slug, runId: r.id }}>
											{r.branch ?? 'unknown branch'}
											{r.commitSha && (
												<>
													{' '}
													<span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65em', fontWeight: 500, color: 'var(--ink-mute)', letterSpacing: 0 }}>
														{r.commitSha.slice(0, 7)}
													</span>
												</>
											)}
										</Link>
									</div>
									<div className="meta">
										<span><span className="num passed">{r.passedScenarios}</span> passed</span>
										{r.failedScenarios > 0 && (
											<>
												<span className="sep">·</span>
												<span><span className="num failed">{r.failedScenarios}</span> failed</span>
											</>
										)}
										<span className="sep">·</span>
										<span className="num">{r.totalScenarios}</span> total
										<span className="sep">·</span>
										<span className="tabular">{fmtDuration(duration)}</span>
									</div>
								</div>
							</div>
						)
					})}
				</div>
			)}
		</>
	)
}
