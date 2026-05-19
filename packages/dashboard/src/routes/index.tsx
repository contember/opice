import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../components/EmptyState'
import { CalendarIcon, FolderIcon } from '../components/Icon'
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
				<h1>Projects</h1>
				<div className="subtitle">
					{data.length === 0
						? 'No projects registered yet.'
						: `${data.length} ${data.length === 1 ? 'project' : 'projects'} reporting into this dashboard.`}
				</div>
			</div>

			{data.length === 0 ? (
				<EmptyState
					icon={<FolderIcon size={32} />}
					title="No projects yet"
					hint="curl -X POST -H 'x-admin-token: …' /api/v1/admin/projects"
				>
					Register a project with the admin endpoint, then point its CI at this worker.
				</EmptyState>
			) : (
				<>
					<div className="toolbar">
						<span className="total">{data.length} {data.length === 1 ? 'project' : 'projects'}</span>
						<span className="pull" />
						<span className="filter">Sort<span className="caret">▾</span></span>
					</div>
					<div className="entry-list has-toolbar">
						{data.map(p => (
							<div className="entry" key={p.id}>
								<span className="e-status">
									<FolderIcon size={18} className="muted" />
								</span>
								<div className="e-body">
									<div className="e-title">
										<Link to="projects/detail" params={{ slug: p.slug }}>{p.name}</Link>
									</div>
									<div className="e-meta">
										<code>{p.slug}</code>
									</div>
								</div>
								<div className="e-aside">
									<span className="row">
										<CalendarIcon className="icon" />
										<span>added {fmtRelative(p.createdAt)}</span>
									</span>
								</div>
							</div>
						))}
					</div>
				</>
			)}
		</>
	)
}
