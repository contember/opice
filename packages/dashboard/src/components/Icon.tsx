interface Props {
	size?: number
	className?: string
}

/**
 * Inline-SVG icon set. Kept tiny on purpose — adding lucide-react or
 * similar pulls in a much bigger dep for the dashboard MVP.
 */

export function CheckIcon({ size = 14, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

export function XIcon({ size = 14, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	)
}

export function ClockIcon({ size = 14, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
			<path d="M8 5v3.5l2 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	)
}

export function ChevronIcon({ size = 12, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
			<path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	)
}

export function FolderIcon({ size = 24, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.5" />
		</svg>
	)
}

export function InboxIcon({ size = 24, className }: Props) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
			<path d="M3 13l3-9h12l3 9M3 13v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6M3 13h5l1 2h6l1-2h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
		</svg>
	)
}
