export function fmtDate(epoch: number): string {
	return new Date(epoch).toISOString().slice(0, 19).replace('T', ' ')
}

export function fmtDuration(ms: number | null | undefined): string {
	if (ms == null) return '—'
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const min = Math.floor(ms / 60_000)
	const sec = Math.floor((ms % 60_000) / 1000)
	return `${min}m ${sec}s`
}

export function fmtRelative(epoch: number, now: number = Date.now()): string {
	const diff = Math.max(0, now - epoch)
	if (diff < 60_000) return 'just now'
	if (diff < 3_600_000) {
		const min = Math.floor(diff / 60_000)
		return `${min}m ago`
	}
	if (diff < 86_400_000) {
		const h = Math.floor(diff / 3_600_000)
		return `${h}h ago`
	}
	if (diff < 604_800_000) {
		const d = Math.floor(diff / 86_400_000)
		return `${d}d ago`
	}
	return fmtDate(epoch).slice(0, 10)
}
