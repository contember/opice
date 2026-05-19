import { useQuery } from '@tanstack/react-query'
import { ChevronIcon } from '../components/Icon'
import { Loading } from '../components/Loading'
import { Stat } from '../components/Stat'
import { StatusBadge } from '../components/StatusBadge'
import { rpc } from '../lib/client'
import { fmtDate, fmtDuration, fmtRelative } from '../lib/format'
import { navigate } from '../lib/router'

interface Props {
	slug: string
	runId: string
}

export function RunPage({ slug, runId }: Props) {
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
	const duration = r.finishedAt ? r.finishedAt - r.startedAt : null

	return (
		<>
			<div className="breadcrumb">
				<a onClick={(e) => { e.preventDefault(); navigate('/') }}>Projects</a>
				<span className="sep">/</span>
				<a onClick={(e) => { e.preventDefault(); navigate(`/p/${slug}`) }}>{project.data.name}</a>
				<span className="sep">/</span>
				<span>Run {r.id.slice(0, 8)}</span>
			</div>

			<div className="page-head">
				<div>
					<h1 className="row" style={{ alignItems: 'center', gap: 12 }}>
						<span>Run {r.id.slice(0, 8)}</span>
						<StatusBadge status={r.status} />
					</h1>
					<div className="subtitle row wrap">
						<span title={fmtDate(r.startedAt)}>Started {fmtRelative(r.startedAt)}</span>
						{r.branch && (
							<>
								<span className="sep" />
								<span>branch <code>{r.branch}</code></span>
							</>
						)}
						{r.commitSha && (
							<>
								<span className="sep" />
								<span>commit <code>{r.commitSha.slice(0, 7)}</code></span>
							</>
						)}
					</div>
				</div>
			</div>

			<div className="stats">
				<Stat label="Total" value={r.totalScenarios} />
				<Stat label="Passed" value={r.passedScenarios} tone={r.passedScenarios > 0 ? 'passed' : 'default'} />
				<Stat label="Failed" value={r.failedScenarios} tone={r.failedScenarios > 0 ? 'failed' : 'default'} />
				<Stat label="Duration" value={fmtDuration(duration)} />
			</div>

			{scenarios.isLoading ? (
				<Loading message="Loading scenarios…" />
			) : !scenarios.data || scenarios.data.length === 0 ? (
				<div className="empty">
					<div className="empty-title">No scenarios reported</div>
				</div>
			) : (
				scenarios.data.map(s => (
					<ScenarioBlock
						key={s.id}
						scenarioId={s.id}
						name={s.name}
						status={s.status}
						hash={s.hash}
						durationMs={s.durationMs}
					/>
				))
			)}
		</>
	)
}

interface ScenarioProps {
	scenarioId: string
	name: string
	status: 'running' | 'passed' | 'failed'
	hash: string | null
	durationMs: number | null
}

function ScenarioBlock({ scenarioId, name, status, hash, durationMs }: ScenarioProps) {
	const steps = useQuery({
		queryKey: ['scenarios.steps', scenarioId],
		queryFn: () => rpc.scenarios.steps({ scenarioId }),
	})

	const failedCount = steps.data?.filter(s => s.status === 'failed').length ?? 0

	return (
		<details className="scenario" open={status === 'failed'}>
			<summary>
				<ChevronIcon className="chevron" />
				<StatusBadge status={status} size="sm" />
				<span className="name">{name}</span>
				<span className="meta">
					{hash && <span className="hash">#{hash}</span>}
					{steps.data && steps.data.length > 0 && (
						<span>
							{steps.data.length} step{steps.data.length === 1 ? '' : 's'}
							{failedCount > 0 && <span style={{ color: 'var(--failed)' }}> · {failedCount} failed</span>}
						</span>
					)}
					<span>{fmtDuration(durationMs)}</span>
				</span>
			</summary>
			{steps.isLoading ? (
				<div className="steps"><Loading message="Loading steps…" /></div>
			) : !steps.data || steps.data.length === 0 ? (
				<div className="steps"><div className="muted" style={{ padding: '12px 0', fontSize: 13 }}>No steps recorded.</div></div>
			) : (
				<div className="steps">
					{steps.data.map(st => (
						<div className="step" key={st.id}>
							<div className="head">
								<StatusBadge status={st.status} size="sm" />
								<span className="name">{st.name}</span>
								<span className="duration">{fmtDuration(st.durationMs)}</span>
							</div>
							{st.error && <div className="err">{st.error}</div>}
							{st.screenshotUrl && (
								<a href={st.screenshotUrl} target="_blank" rel="noreferrer">
									<img className="shot" loading="lazy" src={st.screenshotUrl} alt={`${st.name} screenshot`} />
								</a>
							)}
						</div>
					))}
				</div>
			)}
		</details>
	)
}
