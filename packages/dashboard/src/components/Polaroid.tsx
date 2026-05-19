interface Props {
	src: string
	caption: string
	alt?: string
}

/**
 * Screenshot evidence from a step. Thin bordered frame with a small caption.
 */
export function Polaroid({ src, caption, alt }: Props) {
	return (
		<a className="shot" href={src} target="_blank" rel="noreferrer" title="Open full size">
			<img loading="lazy" src={src} alt={alt ?? caption} />
			<div className="caption">{caption}</div>
		</a>
	)
}
