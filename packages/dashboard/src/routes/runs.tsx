import { createPage } from '@buzola/router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { EmptyState } from '../components/EmptyState'
import { InboxIcon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { Pagination } from '../components/Pagination'
import { RunEntry } from '../components/RunEntry'
import { rpc } from '../lib/client'

const PAGE_SIZE = 30

export default createPage()
	.route('/runs')
	.render(() => <AllRunsPage />)

function AllRunsPage() {
	const [page, setPage] = useState(0)
	const runs = useQuery({
		queryKey: ['runs.listAll', page],
		queryFn: () => rpc.runs.listAll({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
		placeholderData: keepPreviousData,
	})

	if (runs.isLoading) return <Loading message="Loading runs…" />
	if (runs.error) return <div className="error">{(runs.error as Error).message}</div>

	const items = runs.data?.runs ?? []

	return (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<h1>All runs</h1>
				</div>
				<div className="subtitle">Every run across all projects, newest first.</div>
			</div>

			{items.length === 0 && page === 0 ? (
				<EmptyState icon={<InboxIcon size={32} />} title="No runs yet">
					Once any project streams a run, it shows up here.
				</EmptyState>
			) : (
				<>
					<div className="toolbar">
						<span className="total">Runs</span>
						<span className="pull" />
					</div>
					<div className="entry-list has-toolbar">
						{items.map(r => (
							<RunEntry key={r.id} run={r} slug={r.projectSlug} projectName={r.projectName} />
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
