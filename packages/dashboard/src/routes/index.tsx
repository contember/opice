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

	if (isLoading) return <Loading message="Reading the registry…" />
	if (error) return <div className="error">{(error as Error).message}</div>
	if (!data) return null

	return (
		<>
			<div className="page-head">
				<div className="eyebrow">Registry</div>
				<h1>Subjects under observation</h1>
				<div className="subtitle">
					{data.length === 0
						? 'No projects yet — register one to begin.'
						: `${data.length} ${data.length === 1 ? 'project reports' : 'projects report'} into this journal.`}
				</div>
			</div>

			{data.length === 0 ? (
				<EmptyState
					icon={<FolderIcon size={36} />}
					title="The registry is empty"
					hint="curl -X POST -H 'x-admin-token: …' /api/v1/admin/projects"
				>
					Register a project with the admin endpoint, then point its
					CI at this worker.
				</EmptyState>
			) : (
				<div className="entry-list">
					{data.map(p => (
						<div className="entry" key={p.id}>
							<div className="entry-gutter">
								<span className="gutter-time">{fmtRelative(p.createdAt)}</span>
								<span>added</span>
							</div>
							<div className="entry-body">
								<div className="lead">
									<Link to="projects/detail" params={{ slug: p.slug }}>{p.name}</Link>
								</div>
								<div className="meta">
									<code>{p.slug}</code>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</>
	)
}
