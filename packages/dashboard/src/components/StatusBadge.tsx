type Status = 'passed' | 'failed' | 'running' | string

interface Props {
	status: Status
	className?: string
}

const GLYPH: Record<string, string> = {
	passed: '●',
	failed: '✕',
	running: '◐',
}

/**
 * A typographic status mark — never a pill. Lives in the gutter or inline next
 * to a name. See .interface-design/system.md → "Status marks".
 */
export function StatusMark({ status, className }: Props) {
	const glyph = GLYPH[status] ?? '○'
	return (
		<span className={`mark ${status}${className ? ' ' + className : ''}`} aria-label={status}>
			{glyph}
		</span>
	)
}

export function StatusMarkInline({ status }: Props) {
	const glyph = GLYPH[status] ?? '○'
	return (
		<span className={`mark-inline ${status}`}>
			<span aria-hidden>{glyph}</span>
			<span>{status}</span>
		</span>
	)
}

// Back-compat export so older imports don't break during the redesign.
export { StatusMark as StatusBadge }
