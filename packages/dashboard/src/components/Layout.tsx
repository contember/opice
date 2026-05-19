import { type ReactNode } from 'react'
import { navigate, usePathname } from '../lib/router'

interface Props {
	children: ReactNode
}

export function Layout({ children }: Props) {
	const pathname = usePathname()
	return (
		<>
			<header className="app-header">
				<a className="brand" onClick={(e) => { e.preventDefault(); navigate('/') }}>
					<span className="logo">🐒</span>
					<span>opice</span>
				</a>
				<nav className="main">
					<a
						className={pathname === '/' || pathname.startsWith('/p/') ? 'active' : ''}
						onClick={(e) => { e.preventDefault(); navigate('/') }}
					>
						Projects
					</a>
				</nav>
			</header>
			<main>{children}</main>
		</>
	)
}
