interface Props {
	size?: number
	className?: string
}

export function ChevronIcon({ size = 12, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

export function FolderIcon({ size = 24, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.25" />
		</svg>
	)
}

export function InboxIcon({ size = 24, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
			<path d="M3 13l3-9h12l3 9M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6M3 13h5l1 2h6l1-2h5" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
		</svg>
	)
}

export function CalendarIcon({ size = 12, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<rect x="2" y="3.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M2 6.5h12" stroke="currentColor" strokeWidth="1.3" />
			<path d="M5.5 2v3M10.5 2v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	)
}

export function ClockIcon({ size = 12, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<circle cx="8" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M8 5.5V9l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

export function BranchIcon({ size = 12, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<circle cx="4" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="12" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M4 5v6M5.5 6h2A2.5 2.5 0 0 1 10 8.5v0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
			<path d="M12 7.5v0a2.5 2.5 0 0 1-2.5 2.5h-1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
		</svg>
	)
}
