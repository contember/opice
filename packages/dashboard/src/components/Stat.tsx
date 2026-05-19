import { fmtDuration } from '../lib/format'

interface RunSummary {
	totalScenarios: number
	passedScenarios: number
	failedScenarios: number
	startedAt: number
	finishedAt: number | null
}

/**
 * The result strip. Replaces a row of metric cards with one segmented bar +
 * legend. See .interface-design/system.md → "Result strip".
 */
export function ResultStrip({ run }: { run: RunSummary }) {
	const total = Math.max(1, run.totalScenarios)
	const passed = run.passedScenarios
	const failed = run.failedScenarios
	const running = Math.max(0, run.totalScenarios - passed - failed)
	const duration = run.finishedAt ? run.finishedAt - run.startedAt : null

	const seg = (n: number) => ({ flexGrow: n, flexShrink: 0, flexBasis: 0 as const })

	return (
		<div className="result-strip">
			<div className="bar" role="img" aria-label={`${passed} passed, ${failed} failed, ${running} running of ${run.totalScenarios}`}>
				{passed > 0 && <span className="seg passed" style={seg(passed / total)} />}
				{failed > 0 && <span className="seg failed" style={seg(failed / total)} />}
				{running > 0 && <span className="seg running" style={seg(running / total)} />}
			</div>
			<div className="legend">
				{passed > 0 && (
					<span className="item"><span className="swatch passed" /><span className="count">{passed}</span><span className="label-cap">passed</span></span>
				)}
				{failed > 0 && (
					<span className="item"><span className="swatch failed" /><span className="count">{failed}</span><span className="label-cap">failed</span></span>
				)}
				{running > 0 && (
					<span className="item"><span className="swatch running" /><span className="count">{running}</span><span className="label-cap">running</span></span>
				)}
				<span className="item pull">
					<span className="label-cap">duration</span>
					<span className="count">{fmtDuration(duration)}</span>
				</span>
			</div>
		</div>
	)
}
