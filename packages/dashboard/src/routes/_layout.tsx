import { Link, Outlet, useRoute } from '@buzola/router'
import { ThemeSwitcher } from '../components/ThemeSwitcher'

export default function RootLayout() {
	const { pathname } = useRoute()
	const isProjects = pathname === '/' || pathname.startsWith('/p/')

	return (
		<>
			<header className="app-header">
				<div className="inner">
					<Link to="index" className="brand">
						<span className="brand-mark">op</span>
						<span>opice</span>
					</Link>
					<nav className="main">
						<Link to="index" className={isProjects ? 'active' : ''}>
							Projects
						</Link>
					</nav>
				</div>
			</header>
			<main>
				<Outlet />
			</main>
			<ThemeSwitcher />
		</>
	)
}
