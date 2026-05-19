import { useQuery } from '@tanstack/react-query'
import { StatusBadge } from '../components/StatusBadge'
import { rpc } from '../lib/client'
import { fmtDate, fmtDuration } from '../lib/format'
import { navigate } from '../lib/router'

interface Props {
	slug: string
}

export function ProjectPage({ slug }: Props) {
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const runs = useQuery({
		queryKey: ['runs.listForProject', slug],
		queryFn: () => rpc.runs.listForProject({ projectSlug: slug, limit: 50 }),
		enabled: project.isSuccess,
	})

	if (project.isLoading) return <div className="loading"><span className="spinner" /> Loading project…</div>
	if (project.error) return <div className="error">{(project.error as Error).message}</div>
	if (!project.data) return null

	return (
		<>
			<h2>
				{project.data.name}{' '}
				<span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
					/ {project.data.slug}
				</span>
			</h2>
			{runs.isLoading ? (
				<div className="loading"><span className="spinner" /> Loading runs…</div>
			) : runs.data?.length === 0 ? (
				<div className="empty">No runs yet.</div>
			) : (
				<table>
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
						{runs.data?.map(r => (
							<tr key={r.id}>
								<td>
									<a onClick={(e) => { e.preventDefault(); navigate(`/p/${slug}/r/${r.id}`) }}>
										{fmtDate(r.startedAt)}
									</a>
								</td>
								<td><StatusBadge status={r.status} /></td>
								<td>
									{r.passedScenarios}/{r.totalScenarios} passed
									{r.failedScenarios > 0 && <>, <span style={{ color: 'var(--failed-fg)' }}>{r.failedScenarios} failed</span></>}
								</td>
								<td className="muted">
									{r.branch ?? '—'}
									{r.commitSha && <> · <code>{r.commitSha.slice(0, 7)}</code></>}
								</td>
								<td className="muted">
									{r.finishedAt ? fmtDuration(r.finishedAt - r.startedAt) : '—'}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	)
}
