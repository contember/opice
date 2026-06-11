import { Link, Outlet, useRoute } from '@buzola/router'
import { AuthGate } from '../components/AuthGate'
import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { logout, useMe } from '../lib/session'

/**
 * Root layout — the one shell for the whole SPA. It forks on the URL:
 *   - `/s/*` → the PUBLIC share view (outside Cloudflare Access). A bare,
 *     gate-free shell that never mounts `AuthGate` and never calls `session.me`
 *     on `/rpc`, so an anonymous visitor with only a read cookie isn't bounced.
 *   - everything else → the operator shell, wrapped in `AuthGate`.
 *
 * The fork happens at the component boundary (not a conditional hook): the
 * share branch renders `ShareShell`, the operator branch `OperatorShell` — so
 * the session hooks live entirely inside the operator subtree.
 */
export default function RootLayout() {
	const { pathname } = useRoute()
	if (pathname.startsWith('/s/')) return <ShareShell />
	return (
		<AuthGate>
			<OperatorShell />
		</AuthGate>
	)
}

/** Operator chrome: project nav + signed-in identity + sign-out. */
function OperatorShell() {
	const { pathname } = useRoute()
	const isProjects = pathname === '/' || pathname.startsWith('/p/')
	const isRuns = pathname === '/runs'
	// The run view is a wide master/detail workbench — let it break out of the
	// reading-width content column the rest of the app uses.
	const isRunView = pathname.includes('/r/')
	const { data: me } = useMe()

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
						<Link to="runs" className={isRuns ? 'active' : ''}>
							All runs
						</Link>
					</nav>
					{me?.authenticated && (
						<div className="user-menu">
							<Link to="settings" className="user-email">{me.email}</Link>
							<button type="button" className="logout-btn" onClick={logout}>
								Sign out
							</button>
						</div>
					)}
				</div>
			</header>
			<main className={isRunView ? 'wide' : ''}>
				<Outlet />
			</main>
			<ThemeSwitcher />
		</>
	)
}

/**
 * Public share shell — no `AuthGate`, no `session.me`, no operator chrome (no
 * project nav, no sign-out). Just a minimal brand header; the run-detail view
 * renders beneath it, fed entirely by the share RPC client (`/s/rpc`).
 */
function ShareShell() {
	return (
		<>
			<header className="app-header">
				<div className="inner">
					<span className="brand">
						<span className="brand-mark">
							<Logo size={26} />
						</span>
						<span className="brand-text">
							<span className="brand-name">opice</span>
							<span className="brand-sub">shared run</span>
						</span>
					</span>
				</div>
			</header>
			<main className="wide">
				<Outlet />
			</main>
			<ThemeSwitcher />
		</>
	)
}
