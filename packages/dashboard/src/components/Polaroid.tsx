interface Props {
	src: string
	caption: string
	alt?: string
}

/**
 * Photographic evidence from a step. Cream paper frame with a serif-italic
 * caption beneath; clicks open the full image. See system.md → "Polaroid".
 */
export function Polaroid({ src, caption, alt }: Props) {
	return (
		<a className="polaroid" href={src} target="_blank" rel="noreferrer" title="Open full size">
			<img loading="lazy" src={src} alt={alt ?? caption} />
			<div className="caption">{caption}</div>
		</a>
	)
}
