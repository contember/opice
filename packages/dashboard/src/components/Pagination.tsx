import { ChevronIcon } from './Icon'

interface Props {
	page: number
	hasMore: boolean
	count: number
	pageSize: number
	onPage: (page: number) => void
}

/**
 * Offset pagination footer — Prev/Next plus the current 1-based range. We don't
 * know the grand total (offset paging trades it for cheap queries), so there's
 * no last-page jump; `hasMore` comes from a fetched +1 sentinel row.
 */
export function Pagination({ page, hasMore, count, pageSize, onPage }: Props) {
	if (page === 0 && !hasMore) return null
	const from = count === 0 ? 0 : page * pageSize + 1
	const to = page * pageSize + count
	return (
		<div className="pagination">
			<span className="range">{from}–{to}</span>
			<span className="pull" />
			<button type="button" className="page-btn" disabled={page === 0} onClick={() => onPage(page - 1)}>
				<ChevronIcon className="flip" /> Prev
			</button>
			<button type="button" className="page-btn" disabled={!hasMore} onClick={() => onPage(page + 1)}>
				Next <ChevronIcon />
			</button>
		</div>
	)
}
