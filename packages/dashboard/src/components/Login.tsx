import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { signIn } from '../lib/auth-client'
import { setAuthRequired } from '../lib/auth-gate'
import { Logo } from './Logo'

/**
 * Email + password sign-in. Shown when an RPC call comes back unauthorized and
 * there's no session. On success it clears the auth-required flag and refetches
 * every query so the gated views populate without a full reload.
 */
export function Login() {
	const queryClient = useQueryClient()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	async function submit(e: React.FormEvent) {
		e.preventDefault()
		setBusy(true)
		setError(null)
		const { error: signInError } = await signIn.email({ email, password })
		if (signInError) {
			setError(signInError.message ?? 'Sign-in failed')
			setBusy(false)
			return
		}
		setAuthRequired(false)
		await queryClient.invalidateQueries()
		setBusy(false)
	}

	return (
		<div className="login-screen">
			<form className="login-card" onSubmit={submit}>
				<div className="login-head">
					<Logo size={34} />
					<h1>opice</h1>
				</div>
				<p className="login-sub">Sign in to the dashboard</p>
				<label className="login-field">
					<span>Email</span>
					<input
						type="email"
						autoComplete="username"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						autoFocus
					/>
				</label>
				<label className="login-field">
					<span>Password</span>
					<input
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
				</label>
				{error && <p className="login-error">{error}</p>}
				<button type="submit" className="login-submit" disabled={busy}>
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
		</div>
	)
}
