interface Props {
	message?: string
}

export function Loading({ message = 'Observing…' }: Props) {
	return (
		<div className="loading">
			<span className="spinner" /> <span>{message}</span>
		</div>
	)
}
