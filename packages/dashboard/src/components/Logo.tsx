interface Props {
	size?: number
	className?: string
}

/**
 * opice mark — stylized chimp face. Two ear discs, a round head, a U-shaped
 * muzzle, two eye dots. Drawn in `currentColor` so it picks up whatever the
 * parent text color is.
 */
export function Logo({ size = 28, className }: Props) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.8"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			{/* ears */}
			<circle cx="7" cy="11" r="3.4" />
			<circle cx="25" cy="11" r="3.4" />
			{/* head */}
			<circle cx="16" cy="17" r="8.5" />
			{/* muzzle — soft U opening upward */}
			<path d="M11 18 Q16 24 21 18" />
			{/* tiny mouth line at the base of the muzzle */}
			<path d="M14.5 21.5 Q16 22.4 17.5 21.5" strokeWidth="1.4" />
			{/* eyes */}
			<circle cx="13" cy="15.2" r="1" fill="currentColor" stroke="none" />
			<circle cx="19" cy="15.2" r="1" fill="currentColor" stroke="none" />
		</svg>
	)
}
