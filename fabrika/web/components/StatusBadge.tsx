type Status = 'passed' | 'failed' | 'running' | string

interface Props {
	status: Status
	className?: string
}

const LABEL: Record<string, string> = {
	passed: 'Passed',
	failed: 'Failed',
	running: 'Running',
	incomplete: 'Incomplete',
	warning: 'Warning',
	fixme: 'Known failure',
	fixmepass: 'Unexpected pass',
	pending: 'Pending',
	blocked: 'Blocked',
	skipped: 'Skipped',
}

/**
 * The mark drawn inside the status dot. SVG, not a text glyph, so it's
 * geometrically centred in the circle at every size — a unicode '✓'/'!' sits on
 * its font baseline and reads low/off-centre, which is what we're avoiding.
 * Strokes use currentColor so the same mark works white-on-fill or coloured-on-
 * transparent (mini/hollow). viewBox is 16×16; CSS scales it to the dot.
 */
function Mark({ status }: { status: string }) {
	const stroke = {
		fill: 'none',
		stroke: 'currentColor',
		strokeWidth: 2,
		strokeLinecap: 'round' as const,
		strokeLinejoin: 'round' as const,
	}
	switch (status) {
		case 'passed':
			return <svg viewBox="0 0 16 16" aria-hidden><path d="M4.3 8.4l2.4 2.4 5-5.2" {...stroke} /></svg>
		case 'failed':
			return (
				<svg viewBox="0 0 16 16" aria-hidden>
					<path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" {...stroke} />
				</svg>
			)
		case 'running':
			return <svg viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="2.3" fill="currentColor" /></svg>
		case 'fixme':
			return <svg viewBox="0 0 16 16" aria-hidden><path d="M4.2 8.3q1.9-2.3 3.8 0t3.8 0" {...stroke} /></svg>
		case 'blocked':
			// The ring itself is dashed/hollow; a slash makes it read "can't".
			return <svg viewBox="0 0 16 16" aria-hidden><path d="M5.4 10.6l5.2-5.2" {...stroke} /></svg>
		case 'pending':
			// Empty: the dashed ring is the mark.
			return null
		case 'skipped':
			// A dash: declared but deliberately not run (tier filter).
			return <svg viewBox="0 0 16 16" aria-hidden><path d="M4.5 8h7" {...stroke} /></svg>
		case 'incomplete':
		case 'warning':
		case 'fixmepass':
			return (
				<svg viewBox="0 0 16 16" aria-hidden>
					<path d="M8 4v4.6" {...stroke} />
					<circle cx="8" cy="11.6" r="1" fill="currentColor" />
				</svg>
			)
		default:
			return null
	}
}

/**
 * Circled status icon — green check, red cross, amber dot.
 */
export function StatusMark({ status, className }: Props) {
	return (
		<span className={`status-dot ${status}${className ? ' ' + className : ''}`} aria-label={status}>
			<Mark status={status} />
		</span>
	)
}

export function StatusMarkInline({ status }: Props) {
	const label = LABEL[status] ?? status
	return (
		<span className={`status-inline ${status}`}>
			<StatusMark status={status} />
			<span>{label}</span>
		</span>
	)
}

// Back-compat export so older imports don't break.
export { StatusMark as StatusBadge }
