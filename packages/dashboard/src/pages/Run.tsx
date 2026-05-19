import { useQuery } from '@tanstack/react-query'
import { StatusBadge } from '../components/StatusBadge'
import { rpc } from '../lib/client'
import { fmtDate, fmtDuration } from '../lib/format'
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
		return <div className="loading"><span className="spinner" /> Loading…</div>
	}

	const r = run.data
	return (
		<>
			<p className="muted">
				<a onClick={(e) => { e.preventDefault(); navigate(`/p/${slug}`) }}>
					← {project.data.name}
				</a>
			</p>
			<h2>Run · {fmtDate(r.startedAt)} <StatusBadge status={r.status} /></h2>
			<p className="muted">
				{r.passedScenarios}/{r.totalScenarios} scenarios passed
				{r.failedScenarios > 0 && <> · <span style={{ color: 'var(--failed-fg)' }}>{r.failedScenarios} failed</span></>}
				{r.branch && <> · branch <code>{r.branch}</code></>}
				{r.commitSha && <> · commit <code>{r.commitSha.slice(0, 7)}</code></>}
				{r.finishedAt && <> · duration {fmtDuration(r.finishedAt - r.startedAt)}</>}
			</p>
			{scenarios.isLoading ? (
				<div className="loading"><span className="spinner" /> Loading scenarios…</div>
			) : scenarios.data?.length === 0 ? (
				<div className="empty">No scenarios reported.</div>
			) : (
				scenarios.data?.map(s => <ScenarioBlock key={s.id} scenarioId={s.id} name={s.name} status={s.status} hash={s.hash} durationMs={s.durationMs} />)
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

	return (
		<details className="scenario" open={status === 'failed'}>
			<summary>
				<StatusBadge status={status} />
				<span className="name">{name}</span>
				<span className="meta">{hash ? `#${hash} · ` : ''}{fmtDuration(durationMs)}</span>
			</summary>
			{steps.isLoading ? (
				<p className="muted" style={{ margin: '8px 0 0 24px' }}>Loading steps…</p>
			) : !steps.data || steps.data.length === 0 ? (
				<p className="muted" style={{ margin: '8px 0 0 24px' }}>No steps recorded.</p>
			) : (
				<div className="steps">
					{steps.data.map(st => (
						<div className="step" key={st.id}>
							<div className="head">
								<StatusBadge status={st.status} />
								<span>{st.name}</span>
								<span className="muted">{fmtDuration(st.durationMs)}</span>
							</div>
							{st.error && <div className="err">{st.error}</div>}
							{st.screenshotUrl && (
								<img loading="lazy" src={st.screenshotUrl} alt={`${st.name} screenshot`} />
							)}
						</div>
					))}
				</div>
			)}
		</details>
	)
}
