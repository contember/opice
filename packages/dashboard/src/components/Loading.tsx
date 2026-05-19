interface Props {
	message?: string
}

export function Loading({ message = 'Loading…' }: Props) {
	return (
		<div className="loading">
			<span className="spinner" /> {message}
		</div>
	)
}
