import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../../components/EmptyState'
import { InboxIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { StatusBadge } from '../../components/StatusBadge'
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
				<div>
					<h1>{project.data.name}</h1>
					<div className="subtitle">
						<code>{project.data.slug}</code>
						<span className="sep" />
						added {fmtRelative(project.data.createdAt)}
					</div>
				</div>
			</div>

			{runs.isLoading ? (
				<Loading message="Loading runs…" />
			) : !runs.data || runs.data.length === 0 ? (
				<EmptyState
					icon={<InboxIcon size={36} />}
					title="No runs yet"
				>
					Wire up <code>OPICE_PROJECT</code>, <code>OPICE_API_KEY</code>, and <code>OPICE_ENDPOINT</code> in your CI to start streaming results.
				</EmptyState>
			) : (
				<div className="card">
					<table className="runs">
						<thead>
							<tr>
								<th>Started</th>
								<th>Status</th>
								<th>Scenarios</th>
								<th>Branch / commit</th>
								<th>Duration</th>
							</tr>
						</thead>
						<tbody>
							{runs.data.map(r => (
								<tr key={r.id}>
									<td>
										<Link to="projects/run" params={{ slug, runId: r.id }}>
											{fmtRelative(r.startedAt)}
										</Link>
									</td>
									<td><StatusBadge status={r.status} /></td>
									<td>
										<span style={{ color: 'var(--passed)' }}>{r.passedScenarios}</span>
										<span className="muted"> / {r.totalScenarios}</span>
										{r.failedScenarios > 0 && (
											<>
												<span className="muted">, </span>
												<span style={{ color: 'var(--failed)' }}>{r.failedScenarios} failed</span>
											</>
										)}
									</td>
									<td className="muted">
										{r.branch ?? <span style={{ opacity: 0.5 }}>—</span>}
										{r.commitSha && <> · <code>{r.commitSha.slice(0, 7)}</code></>}
									</td>
									<td className="muted">
										{r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : '—'}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	)
}
