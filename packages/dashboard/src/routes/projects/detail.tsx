import { createPage, Link } from '@buzola/router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { InboxIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { Pagination } from '../../components/Pagination'
import { RunEntry } from '../../components/RunEntry'
import { rpc } from '../../lib/client'
import { fmtRelative } from '../../lib/format'

const PAGE_SIZE = 30

export default createPage()
	.params({ slug: 'string' })
	.route('/p/:slug')
	.render(({ params }) => <ProjectPage slug={params.slug} />)

function ProjectPage({ slug }: { slug: string }) {
	const [page, setPage] = useState(0)
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const runs = useQuery({
		queryKey: ['runs.listForProject', slug, page],
		queryFn: () => rpc.runs.listForProject({ projectSlug: slug, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
		enabled: project.isSuccess,
		placeholderData: keepPreviousData,
	})

	if (project.isLoading) return <Loading message="Loading project…" />
	if (project.error) return <div className="error">{(project.error as Error).message}</div>
	if (!project.data) return null

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
					Wire <code>OPICE_PROJECT</code>, <code>OPICE_API_KEY</code> and{' '}
					<code>OPICE_ENDPOINT</code> in your CI to start streaming runs.
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
							<RunEntry key={r.id} run={r} slug={slug} />
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
