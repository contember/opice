import { Link, Outlet, useRoute } from '@buzola/router'
import { useQueryClient } from '@tanstack/react-query'
import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { signOut, useSession } from '../lib/auth-client'

export default function RootLayout() {
	const { pathname } = useRoute()
	const isProjects = pathname === '/' || pathname.startsWith('/p/')
	const { data: session } = useSession()
	const queryClient = useQueryClient()

	async function logout() {
		await signOut()
		await queryClient.invalidateQueries()
	}

	return (
		<>
			<header className="app-header">
				<div className="inner">
					<Link to="index" className="brand">
						<span className="brand-mark">
							<Logo size={26} />
						</span>
						<span className="brand-text">
							<span className="brand-name">opice</span>
							<span className="brand-sub">test runs</span>
						</span>
					</Link>
					<nav className="main">
						<Link to="index" className={isProjects ? 'active' : ''}>
							Projects
						</Link>
					</nav>
					{session && (
						<div className="user-menu">
							<span className="user-email">{session.user.email}</span>
							<button type="button" className="logout-btn" onClick={logout}>
								Sign out
							</button>
						</div>
					)}
				</div>
			</header>
			<main>
				<Outlet />
			</main>
			<ThemeSwitcher />
		</>
	)
}
