import { Link } from '@buzola/router'
import { fmtDuration, fmtRelative } from '../lib/format'
import { CalendarIcon, ClockIcon } from './Icon'
import { StatusMark } from './StatusBadge'

interface RunLike {
	id: string
	branch: string | null
	commitSha: string | null
	status: 'running' | 'passed' | 'failed' | 'incomplete'
	source: 'ci' | 'local' | null
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	startedAt: number
	finishedAt: number | null
}

/**
 * One row in a run list. Used by both the per-project list and the cross-project
 * feed; pass `projectName` to surface which project the run belongs to.
 */
export function RunEntry({ run: r, slug, projectName }: { run: RunLike; slug: string; projectName?: string }) {
	const duration = r.finishedAt ? r.finishedAt - r.startedAt : null
	return (
		<div className="entry">
			<span className="e-status">
				<StatusMark status={r.status} />
			</span>
			<div className="e-body">
				<div className="e-title">
					<Link to="projects/run" params={{ slug, runId: r.id }}>
						{projectName && <span className="e-project">{projectName} · </span>}
						Run {r.id.slice(0, 8)}
						{r.commitSha && (
							<> · <span style={{ fontWeight: 400, color: 'var(--text-soft)' }}>commit {r.commitSha.slice(0, 7)}</span></>
						)}
					</Link>
				</div>
				<div className="e-meta">
					<span><strong className="tabular">{r.passedScenarios}</strong> passed</span>
					{r.failedScenarios > 0 && (
						<>
							<span className="sep">·</span>
							<span style={{ color: 'var(--fail)' }}><strong className="tabular" style={{ color: 'var(--fail)' }}>{r.failedScenarios}</strong> failed</span>
						</>
					)}
					<span className="sep">·</span>
					<span><strong className="tabular">{r.totalScenarios}</strong> total</span>
				</div>
			</div>
			{r.source === 'local' && <span className="e-chip chip chip-local" title="Reported from a local dev run">local</span>}
			{r.branch && <span className="e-chip chip">{r.branch}</span>}
			<div className="e-aside">
				<span className="row">
					<CalendarIcon className="icon" />
					<span>{fmtRelative(r.startedAt)}</span>
				</span>
				<span className="row">
					<ClockIcon className="icon" />
					<span className="tabular">{fmtDuration(duration)}</span>
				</span>
			</div>
		</div>
	)
}
