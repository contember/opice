export function fmtDate(epoch: number): string {
	return new Date(epoch).toISOString().slice(0, 19).replace('T', ' ')
}

export function fmtDuration(ms: number | null | undefined): string {
	if (ms == null) return '—'
	if (ms < 1000) return `${ms}ms`
	return `${(ms / 1000).toFixed(1)}s`
}
