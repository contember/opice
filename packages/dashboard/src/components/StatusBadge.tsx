import { CheckIcon, ClockIcon, XIcon } from './Icon'

interface Props {
	status: 'passed' | 'failed' | 'running' | string
	size?: 'sm' | 'md'
}

export function StatusBadge({ status, size = 'md' }: Props) {
	const Icon = status === 'passed' ? CheckIcon : status === 'failed' ? XIcon : ClockIcon
	const iconSize = size === 'sm' ? 11 : 13
	return (
		<span className={`badge ${status} ${status === 'running' ? 'running-pulse' : ''}`}>
			<Icon size={iconSize} />
			<span>{status}</span>
		</span>
	)
}
