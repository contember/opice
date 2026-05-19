import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../components/EmptyState'
import { FolderIcon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { rpc } from '../lib/client'
import { fmtRelative } from '../lib/format'

export default createPage()
	.route('/')
	.render(() => <ProjectsPage />)

function ProjectsPage() {
	const { data, isLoading, error } = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => rpc.projects.list(),
	})

	if (isLoading) return <Loading message="Loading projects…" />
	if (error) return <div className="error">{(error as Error).message}</div>
	if (!data) return null

	return (
		<>
			<div className="page-head">
				<div>
					<h1>Projects</h1>
					<div className="subtitle">
						{data.length} {data.length === 1 ? 'project' : 'projects'} sending runs to opice
					</div>
				</div>
			</div>

			{data.length === 0 ? (
				<EmptyState
					icon={<FolderIcon size={36} />}
					title="No projects yet"
					hint="curl -X POST -H 'x-admin-token: ...' /api/v1/admin/projects"
				>
					Create one with the admin endpoint.
				</EmptyState>
			) : (
				<div className="card">
					<table className="runs">
						<thead>
							<tr>
								<th>Project</th>
								<th>Slug</th>
								<th>Added</th>
							</tr>
						</thead>
						<tbody>
							{data.map(p => (
								<tr key={p.id}>
									<td>
										<Link to="projects/detail" params={{ slug: p.slug }}>{p.name}</Link>
									</td>
									<td><code className="muted">{p.slug}</code></td>
									<td className="muted">{fmtRelative(p.createdAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</>
	)
}
