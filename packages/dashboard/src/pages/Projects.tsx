import { useQuery } from '@tanstack/react-query'
import { rpc } from '../lib/client'
import { fmtDate } from '../lib/format'
import { navigate } from '../lib/router'

export function ProjectsPage() {
	const { data, isLoading, error } = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => rpc.projects.list(),
	})

	if (isLoading) return <div className="loading"><span className="spinner" /> Loading…</div>
	if (error) return <div className="error">{(error as Error).message}</div>
	if (!data) return null

	if (data.length === 0) {
		return <div className="empty">No projects yet. Register one with the admin tool.</div>
	}

	return (
		<>
			<h2>Projects</h2>
			<table>
				<thead>
					<tr><th>Project</th><th>Slug</th><th>Created</th></tr>
				</thead>
				<tbody>
					{data.map(p => (
						<tr key={p.id}>
							<td>
								<a onClick={(e) => { e.preventDefault(); navigate(`/p/${p.slug}`) }}>
									{p.name}
								</a>
							</td>
							<td><code className="muted">{p.slug}</code></td>
							<td className="muted">{fmtDate(p.createdAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</>
	)
}
