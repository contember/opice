import { Link, Outlet, useRoute } from '@buzola/router'
import { ThemeSwitcher } from '../components/ThemeSwitcher'

export default function RootLayout() {
	const { pathname } = useRoute()
	const isProjects = pathname === '/' || pathname.startsWith('/p/')

	return (
		<>
			<header className="app-header">
				<Link to="index" className="brand">
					<span>opice</span>
					<span className="brand-tag">Field journal</span>
				</Link>
				<nav className="main">
					<Link to="index" className={isProjects ? 'active' : ''}>
						Subjects
					</Link>
				</nav>
			</header>
			<main>
				<Outlet />
			</main>
			<ThemeSwitcher />
		</>
	)
}
