import type { ReactNode } from 'react'
import { useAuthRequired } from '../lib/auth-gate'
import { useMe } from '../lib/session'
import { Logo } from './Logo'

/**
 * Gates the OPERATOR shell (the `(app)` layout) — it is not mounted by the
 * public `(share)` routes. Decides whether to render the app or the "access
 * required" screen:
 *   - a query came back 401 (auth-required flag set) → access required.
 *   - session.me is still loading → render nothing (child loaders do the real
 *     work; there is no lingering empty-state flash to worry about).
 *   - me resolved (an authenticated operator) → app.
 *
 * The 401 signal comes from `useAuthRequired`, set by the react-query cache
 * callbacks in `main.tsx`. Signing in means going through Cloudflare Access —
 * there is no app-managed form here.
 */
export function AuthGate({ children }: { children: ReactNode }) {
	const me = useMe()
	const authRequired = useAuthRequired()

	if (authRequired) return <AccessRequired />
	if (me.isPending) return null
	return <>{children}</>
}

/**
 * Full-screen "sign in via your organisation" prompt. Shown when the worker
 * returned 401 — the Access session is missing or expired. The only action
 * available is a page reload, which triggers the Access challenge redirect.
 */
function AccessRequired() {
	return (
		<div className="login-screen">
			<div className="login-card">
				<div className="login-head">
					<Logo size={34} />
					<h1>opice</h1>
				</div>
				<p className="login-sub">Sign in through your organisation to access this dashboard.</p>
				<button
					type="button"
					className="login-submit"
					onClick={() => location.reload()}
				>
					Reload
				</button>
			</div>
		</div>
	)
}
