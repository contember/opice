import { fmtDuration } from '../lib/format'

interface RunSummary {
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	warningScenarios: number
	startedAt: number
	finishedAt: number | null
}

/**
 * Run summary — a row of stat cells (total, passed, warning, failed, running,
 * duration) with a thin segmented progress bar pinned at the bottom.
 */
export function ResultStrip({ run }: { run: RunSummary }) {
	const total = Math.max(1, run.totalScenarios)
	const failed = run.failedScenarios
	const warning = run.warningScenarios
	// warningScenarios is a subset of passedScenarios — split it out so the
	// "Passed" cell counts only clean passes.
	const passed = Math.max(0, run.passedScenarios - warning)
	const running = Math.max(0, run.totalScenarios - run.passedScenarios - failed)
	const duration = run.finishedAt ? run.finishedAt - run.startedAt : null

	const seg = (n: number) => ({ flexGrow: n, flexShrink: 0, flexBasis: 0 as const })

	return (
		<div className="summary">
			<div className="cell">
				<span className="k">Scenarios</span>
				<span className="v">{run.totalScenarios}</span>
			</div>
			<div className="cell">
				<span className="k">Passed</span>
				<span className="v passed">{passed}</span>
			</div>
			{warning > 0 && (
				<div className="cell">
					<span className="k">Warnings</span>
					<span className="v warning">{warning}</span>
				</div>
			)}
			<div className="cell">
				<span className="k">Failed</span>
				<span className={`v${failed > 0 ? ' failed' : ''}`}>{failed}</span>
			</div>
			{running > 0 && (
				<div className="cell">
					<span className="k">Running</span>
					<span className="v running">{running}</span>
				</div>
			)}
			<div className="cell">
				<span className="k">Duration</span>
				<span className="v">{fmtDuration(duration)}</span>
			</div>
			<div className="bar" role="img" aria-label={`${passed} passed, ${warning} warning, ${failed} failed, ${running} running of ${run.totalScenarios}`}>
				{passed > 0 && <span className="seg passed" style={seg(passed / total)} />}
				{warning > 0 && <span className="seg warning" style={seg(warning / total)} />}
				{failed > 0 && <span className="seg failed" style={seg(failed / total)} />}
				{running > 0 && <span className="seg running" style={seg(running / total)} />}
			</div>
		</div>
	)
}
