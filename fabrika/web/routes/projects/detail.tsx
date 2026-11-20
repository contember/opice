import { createPage, Link } from '@buzola/router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { InboxIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { Pagination } from '../../components/Pagination'
import { RunEntry } from '../../components/RunEntry'
import { api } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fmtRelative } from '../../lib/format'
import { useProject } from '../../lib/project'

const PAGE_SIZE = 30

export default createPage()
	.params({ project: 'string' })
	.route('/p/:project')
	.render(({ params }) => <ProjectPage projectRef={params.project} />)

function ProjectPage({ projectRef }: { projectRef: string }) {
	const [page, setPage] = useState(0)
	const project = useProject(projectRef)
	const projectId = project.data?.id
	const runs = useQuery({
		queryKey: ['runs.listForProject', projectId, page],
		queryFn: () => api.runs.listForProject({ projectId: projectId ?? '', limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
		enabled: projectId !== undefined,
		placeholderData: keepPreviousData,
	})

	if (project.isLoading) return <Loading message="Loading project…" />
	if (project.error) return <div className="error">{errorMessage(project.error)}</div>
	if (!project.data) return <div className="error">Project not found: {projectRef}</div>
	const slug = project.data.slug

	const items = runs.data?.runs ?? []

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
					<span>id <code className="project-id">{project.data.id}</code></span>
					<span className="sep">·</span>
					<span>added {fmtRelative(project.data.createdAt)}</span>
				</div>
			</div>

			{runs.isLoading ? (
				<Loading message="Loading runs…" />
			) : items.length === 0 && page === 0 ? (
				<EmptyState
					icon={<InboxIcon size={32} />}
					title="No runs yet"
				>
					Set <code>OPICE_DSN=https://&lt;px_ key&gt;@{window.location.host}/{project.data.id}</code> in your CI to start
					streaming runs. An installation administrator mints the key in the platform console.
				</EmptyState>
			) : (
				<>
					<div className="toolbar">
						<span className="total">Runs</span>
						<span className="pull" />
						<span className="filter">Status<span className="caret">▾</span></span>
						<span className="filter">Branch<span className="caret">▾</span></span>
						<span className="filter">Commit<span className="caret">▾</span></span>
					</div>
					<div className="entry-list has-toolbar">
						{items.map(r => (
							<RunEntry key={r.id} run={r} project={slug} />
						))}
					</div>
					<Pagination
						page={page}
						hasMore={runs.data?.hasMore ?? false}
						count={items.length}
						pageSize={PAGE_SIZE}
						onPage={setPage}
					/>
				</>
			)}
		</>
	)
}
