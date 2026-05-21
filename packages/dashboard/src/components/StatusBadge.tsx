type Status = 'passed' | 'failed' | 'running' | string

interface Props {
	status: Status
	className?: string
}

const GLYPH: Record<string, string> = {
	passed: '✓',
	failed: '✕',
	running: '·',
	incomplete: '!',
}

const LABEL: Record<string, string> = {
	passed: 'Passed',
	failed: 'Failed',
	running: 'Running',
	incomplete: 'Incomplete',
}

/**
 * Circled status icon — green check, red cross, amber pulsing dot.
 */
export function StatusMark({ status, className }: Props) {
	const glyph = GLYPH[status] ?? '?'
	return (
		<span className={`status-dot ${status}${className ? ' ' + className : ''}`} aria-label={status}>
			{glyph}
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
