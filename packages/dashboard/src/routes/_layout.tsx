import { Link, Outlet, useRoute } from '@buzola/router'

export default function RootLayout() {
	const { pathname } = useRoute()
	const isProjects = pathname === '/' || pathname.startsWith('/p/')

	return (
		<>
			<header className="app-header">
				<Link to="index" className="brand">
					<span className="logo">🐒</span>
					<span>opice</span>
				</Link>
				<nav className="main">
					<Link to="index" className={isProjects ? 'active' : ''}>
						Projects
					</Link>
				</nav>
			</header>
			<main>
				<Outlet />
			</main>
		</>
	)
}
