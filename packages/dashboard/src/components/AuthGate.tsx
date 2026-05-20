import type { ReactNode } from 'react'
import { useSession } from '../lib/auth-client'
import { useAuthRequired } from '../lib/auth-gate'
import { Login } from './Login'

/**
 * Decides whether to render the app or the sign-in screen:
 *   - logged-in operator (session present) → app, always.
 *   - logged out, but a query came back 401 → sign-in screen.
 *   - logged out and queries succeed (read-token link) → app.
 *
 * The 401 signal comes from `useAuthRequired`, set by the react-query cache
 * callbacks in `main.tsx`.
 */
export function AuthGate({ children }: { children: ReactNode }) {
	const { data: session } = useSession()
	const authRequired = useAuthRequired()

	if (!session && authRequired) return <Login />
	return <>{children}</>
}
