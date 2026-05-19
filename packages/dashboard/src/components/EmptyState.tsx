import type { ReactNode } from 'react'

interface Props {
	icon?: ReactNode
	title: string
	children?: ReactNode
	hint?: string
}

export function EmptyState({ icon, title, children, hint }: Props) {
	return (
		<div className="empty">
			{icon && <div className="empty-icon">{icon}</div>}
			<div className="empty-title">{title}</div>
			{children && <div className="empty-body">{children}</div>}
			{hint && <div className="hint">{hint}</div>}
		</div>
	)
}
