import { type ReactNode } from 'react'
import { navigate } from '../lib/router'

interface Props {
	children: ReactNode
}

export function Layout({ children }: Props) {
	return (
		<>
			<header>
				<h1>
					<a onClick={(e) => { e.preventDefault(); navigate('/') }}>
						🐒 opice
					</a>
				</h1>
				<nav>
					<a onClick={(e) => { e.preventDefault(); navigate('/') }}>projects</a>
				</nav>
			</header>
			<main>{children}</main>
		</>
	)
}
