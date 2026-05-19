import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { ChevronIcon, ClockIcon } from '../../components/Icon'
import { Loading } from '../../components/Loading'
import { Polaroid } from '../../components/Polaroid'
import { ResultStrip } from '../../components/Stat'
import { StatusMark, StatusMarkInline } from '../../components/StatusBadge'
import { rpc } from '../../lib/client'
import { fmtDate, fmtDuration, fmtRelative } from '../../lib/format'

export default createPage()
	.params({ slug: 'string', runId: 'string' })
	.route('/p/:slug/r/:runId')
	.render(({ params }) => <RunPage slug={params.slug} runId={params.runId} />)

function RunPage({ slug, runId }: { slug: string; runId: string }) {
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const run = useQuery({
		queryKey: ['runs.get', runId],
		queryFn: () => rpc.runs.get({ runId }),
	})
	const scenarios = useQuery({
		queryKey: ['runs.scenarios', runId],
		queryFn: () => rpc.runs.scenarios({ runId }),
	})

	if (project.error || run.error) {
		return <div className="error">{((project.error ?? run.error) as Error).message}</div>
	}
	if (!project.data || !run.data) {
		return <Loading />
	}

	const r = run.data

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<Link to="projects/detail" params={{ slug }}>{project.data.name}</Link>
				<span className="sep">/</span>
				<span>Run {r.id.slice(0, 8)}</span>
			</div>

			<div className="page-head">
				<h1>
					<StatusMarkInline status={r.status} />
					<span>Run {r.id.slice(0, 8)}</span>
				</h1>
				<div className="subtitle">
					{r.branch && <span className="chip">{r.branch}</span>}
					{r.commitSha && (
						<>
							<span className="sep">·</span>
							<span>commit <code>{r.commitSha.slice(0, 7)}</code></span>
						</>
					)}
					<span className="sep">·</span>
					<span title={fmtDate(r.startedAt)}>started {fmtRelative(r.startedAt)}</span>
				</div>
			</div>

			<ResultStrip run={r} />

			<div className="section-head">
				<span className="label">Scenarios</span>
				<span className="count">{scenarios.data?.length ?? 0}</span>
			</div>

			{scenarios.isLoading ? (
				<Loading message="Loading scenarios…" />
			) : !scenarios.data || scenarios.data.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No scenarios reported</div>
				</div>
			) : (
				<div className="scenarios">
					{scenarios.data.map((s, i) => (
						<ScenarioBlock
							key={s.id}
							index={i + 1}
							scenarioId={s.id}
							name={s.name}
							status={s.status}
							hash={s.hash}
							durationMs={s.durationMs}
						/>
					))}
				</div>
			)}
		</>
	)
}

interface ScenarioProps {
	index: number
	scenarioId: string
	name: string
	status: 'running' | 'passed' | 'failed'
	hash: string | null
	durationMs: number | null
}

function ScenarioBlock({ index, scenarioId, name, status, hash, durationMs }: ScenarioProps) {
	const steps = useQuery({
		queryKey: ['scenarios.steps', scenarioId],
		queryFn: () => rpc.scenarios.steps({ scenarioId }),
	})

	const failedCount = steps.data?.filter(s => s.status === 'failed').length ?? 0

	return (
		<details className="scenario" open={status === 'failed'}>
			<summary>
				<ChevronIcon className="chevron" />
				<StatusMark status={status} />
				<span className="s-num">#{String(index).padStart(2, '0')}</span>
				<span className="s-name">{name}</span>
				<span className="s-aside">
					{steps.data && steps.data.length > 0 && (
						<span>
							{steps.data.length} {steps.data.length === 1 ? 'step' : 'steps'}
							{failedCount > 0 && (
								<span style={{ color: 'var(--fail)' }}> · {failedCount} failed</span>
							)}
						</span>
					)}
					{hash && <span className="hash">#{hash}</span>}
					<span className="duration">
						<ClockIcon className="icon" />
						<span className="tabular">{fmtDuration(durationMs)}</span>
					</span>
				</span>
			</summary>
			{steps.isLoading ? (
				<div className="steps"><Loading message="Loading steps…" /></div>
			) : !steps.data || steps.data.length === 0 ? (
				<div className="steps">
					<div className="muted" style={{ padding: '12px 16px', fontSize: 12.5 }}>
						No steps recorded.
					</div>
				</div>
			) : (
				<div className="steps">
					{steps.data.map(st => (
						<div className="step" key={st.id}>
							<span className="step-mark"><StatusMark status={st.status} /></span>
							<span className="step-name">{st.name}</span>
							<span className="duration">{fmtDuration(st.durationMs)}</span>
							{(st.error || st.screenshotUrl) && (
								<div className="step-detail">
									{st.error && <div className="step-error">{st.error}</div>}
									{st.screenshotUrl && <Polaroid src={st.screenshotUrl} caption={st.name} />}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</details>
	)
}
