interface Props {
	label: string
	value: string | number
	tone?: 'default' | 'passed' | 'failed' | 'running'
}

export function Stat({ label, value, tone = 'default' }: Props) {
	return (
		<div className="stat">
			<span className="label">{label}</span>
			<span className={`value ${tone === 'default' ? '' : tone}`}>{value}</span>
		</div>
	)
}
