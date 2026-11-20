import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { EmptyState } from '../components/EmptyState'
import { CalendarIcon, FolderIcon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { NewProject } from '../components/NewProject'
import { StatusMark } from '../components/StatusBadge'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'
import { fmtRelative } from '../lib/format'
import { useCanWrite } from '../lib/session'

export default createPage()
	.route('/')
	.render(() => <ProjectsPage />)

type Project = Awaited<ReturnType<typeof api.projects.list>>['projects'][number]

function ProjectsPage() {
	const list = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => api.projects.list(),
	})
	const canWrite = useCanWrite()

	if (list.isLoading) return <Loading message="Loading projects…" />
	if (list.error) return <div className="error">{errorMessage(list.error)}</div>
	if (!list.data) return null
	const data = list.data.projects

	return (
		<>
			<div className="page-head">
				<div className="page-head-row">
					<h1>Projects</h1>
					{canWrite && <NewProject />}
				</div>
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
					hint="Click “New project” to create one"
				>
					Create a project, ask an installation administrator for its service key, then put the DSN into your repo's <code>.env</code>.
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
										<Link to="projects/detail" params={{ project: p.slug }}>{p.name}</Link>
									</div>
									<div className="e-meta">
										<code>{p.slug}</code>
										<span className="sep">·</span>
										<span>added {fmtRelative(p.createdAt)}</span>
									</div>
								</div>
								<LastRunSummary slug={p.slug} run={p.lastRun} />
							</div>
						))}
					</div>
				</>
			)}
		</>
	)
}

/** Compact headline-run summary shown on the right of a project row. */
function LastRunSummary({ slug, run }: { slug: string; run: Project['lastRun'] }) {
	if (!run) {
		return (
			<div className="e-aside">
				<span className="muted">no runs yet</span>
			</div>
		)
	}
	return (
		<Link to="projects/run" params={{ project: slug, runId: run.id }} className="last-run">
			<StatusMark status={run.status} />
			<span className="last-run-counts">
				<strong className="tabular">{run.passedScenarios}</strong>
				<span className="sep">/</span>
				<span className="tabular">{run.totalScenarios}</span>
			</span>
			{run.failedScenarios > 0 && (
				<span className="last-run-failed tabular">{run.failedScenarios} failed</span>
			)}
			{run.warningScenarios > 0 && (
				<span className="tabular" style={{ color: 'var(--run)' }}>{run.warningScenarios} warning</span>
			)}
			{run.branch && <span className="chip">{run.branch}</span>}
			<span className="last-run-time">
				<CalendarIcon className="icon" />
				{fmtRelative(run.startedAt)}
			</span>
		</Link>
	)
}
