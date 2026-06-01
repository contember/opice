import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { changePassword, isOperator, useSession } from '../lib/auth-client'
import { rpc } from '../lib/client'
import { RpcError } from '../lib/rpc-client'

export default createPage()
	.route('/settings')
	.render(() => <SettingsPage />)

function SettingsPage() {
	const { data: session, isPending } = useSession()

	if (isPending) return null
	// Share-link visitors (no session) have no account to manage.
	if (!session) return <div className="error">Sign in to manage your account.</div>

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<span>Settings</span>
			</div>

			<div className="page-head">
				<h1>Settings</h1>
				<div className="subtitle">
					Signed in as <code>{session.user.email}</code>
				</div>
			</div>

			<ChangePassword />
			{isOperator(session.user) && <InvitePeople />}
			{isOperator(session.user) && <TokenManager />}
		</>
	)
}

interface TokenSummary {
	id: string
	capability: 'read' | 'write' | 'admin'
	projectSlug: string | null
	runId: string | null
	label: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
}

/**
 * Operator-only: the full token inventory + minting. The headline use is a
 * project-scoped *read* token an authoring agent drops into `.env` as
 * OPICE_READ_DSN to pull results back — the same key the "new project" flow
 * hands out, available here after the fact and for existing projects.
 */
function TokenManager() {
	const queryClient = useQueryClient()
	const host = typeof window !== 'undefined' ? window.location.host : ''
	const [projectSlug, setProjectSlug] = useState('')
	const [capability, setCapability] = useState<'read' | 'write'>('read')
	const [label, setLabel] = useState('agent-read')
	const [minted, setMinted] = useState<string | null>(null)

	const projects = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => rpc.projects.list(),
	})

	const tokens = useQuery({
		queryKey: ['admin.listTokens'],
		queryFn: () => rpc.admin.listTokens({}),
	})

	// A global (project-less) token is read-only by construction; keep the UI honest.
	const effectiveCapability = projectSlug ? capability : 'read'

	const create = useMutation({
		mutationFn: () =>
			rpc.admin.createToken({
				...(projectSlug ? { projectSlug } : {}),
				capability: effectiveCapability,
				label: label.trim() || undefined,
			}),
		onSuccess: ({ token }) => {
			if (projectSlug) {
				const envVar = effectiveCapability === 'read' ? 'OPICE_READ_DSN' : 'OPICE_DSN'
				setMinted(`${envVar}=https://${token}@${host}/${projectSlug}`)
			} else {
				setMinted(token)
			}
			queryClient.invalidateQueries({ queryKey: ['admin.listTokens'] })
		},
	})

	const revoke = useMutation({
		mutationFn: (tokenId: string) => rpc.admin.revokeToken({ tokenId }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin.listTokens'] }),
	})

	const errorMessage = create.error
		? create.error instanceof RpcError
			? create.error.message
			: (create.error as Error).message
		: null

	return (
		<div className="new-project-panel">
			<div className="np-head">
				<h2>API tokens</h2>
			</div>
			<p className="np-hint">
				Mint a project-scoped read token for an authoring agent (it reads results via
				OPICE_READ_DSN), or a write/ingest key for CI. Global tokens are read-only.
			</p>

			<form
				onSubmit={(e) => {
					e.preventDefault()
					setMinted(null)
					create.mutate()
				}}
			>
				<label className="np-field">
					<span>Project</span>
					<select className="np-select" value={projectSlug} onChange={(e) => setProjectSlug(e.target.value)}>
						<option value="">All projects (global, read-only)</option>
						{projects.data?.map((p) => (
							<option key={p.slug} value={p.slug}>{p.name} ({p.slug})</option>
						))}
					</select>
				</label>
				<label className="np-field">
					<span>Capability</span>
					<select
						className="np-select"
						value={effectiveCapability}
						disabled={!projectSlug}
						onChange={(e) => setCapability(e.target.value as 'read' | 'write')}
					>
						<option value="read">Read — pull results (agent / dashboard)</option>
						<option value="write">Write — report runs (CI ingest)</option>
					</select>
				</label>
				<label className="np-field">
					<span>Label (optional)</span>
					<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="agent-read" />
				</label>

				{errorMessage && <p className="np-error">{errorMessage}</p>}
				<button type="submit" className="btn-primary" disabled={create.isPending}>
					{create.isPending ? 'Creating…' : 'Create token'}
				</button>
			</form>

			{minted && (
				<>
					<p className="np-warn">Shown once — copy it now (only its hash is stored).</p>
					<CopyBlock value={minted} />
				</>
			)}

			<label className="np-label">Existing tokens</label>
			{tokens.data && tokens.data.length > 0 ? (
				<ul className="share-list">
					{(tokens.data as TokenSummary[]).map((t) => {
						const scope = t.runId ? `run ${t.runId.slice(0, 8)}…` : (t.projectSlug ?? 'all projects')
						return (
							<li key={t.id} className="share-row">
								<code className="share-id">{t.id.slice(0, 8)}…</code>
								<span className="share-meta">
									{t.label ?? '(no label)'} · {t.capability} · {scope}
									{t.expiresAt ? ` · expires ${new Date(t.expiresAt).toISOString().slice(0, 10)}` : ''}
									{t.lastUsedAt ? ` · used ${new Date(t.lastUsedAt).toISOString().slice(0, 10)}` : ' · never used'}
								</span>
								<button
									type="button"
									className="share-copy"
									onClick={() => revoke.mutate(t.id)}
									disabled={revoke.isPending}
								>
									Revoke
								</button>
							</li>
						)
					})}
				</ul>
			) : (
				<span className="np-hint">No tokens yet.</span>
			)}
		</div>
	)
}

/** Self-service password change for the signed-in operator. */
function ChangePassword() {
	const [current, setCurrent] = useState('')
	const [next, setNext] = useState('')
	const [confirm, setConfirm] = useState('')
	const [done, setDone] = useState(false)

	const mutation = useMutation({
		mutationFn: async () => {
			const res = await changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
			if (res.error) throw new Error(res.error.message ?? 'Failed to change password')
			return res
		},
		onSuccess: () => {
			setDone(true)
			setCurrent('')
			setNext('')
			setConfirm('')
		},
	})

	const mismatch = confirm.length > 0 && next !== confirm
	const tooShort = next.length > 0 && next.length < 10

	return (
		<form
			className="new-project-panel"
			onSubmit={(e) => {
				e.preventDefault()
				if (mismatch || tooShort) return
				setDone(false)
				mutation.mutate()
			}}
		>
			<div className="np-head">
				<h2>Change password</h2>
			</div>

			<label className="np-field">
				<span>Current password</span>
				<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
			</label>
			<label className="np-field">
				<span>New password</span>
				<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} required />
			</label>
			<label className="np-field">
				<span>Confirm new password</span>
				<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
			</label>

			{tooShort && <p className="np-error">Password must be at least 10 characters.</p>}
			{mismatch && <p className="np-error">Passwords don't match.</p>}
			{mutation.error && <p className="np-error">{(mutation.error as Error).message}</p>}
			{done && <p className="np-hint">✓ Password changed. Other sessions were signed out.</p>}

			<button type="submit" className="btn-primary" disabled={mutation.isPending || mismatch || tooShort}>
				{mutation.isPending ? 'Saving…' : 'Change password'}
			</button>
		</form>
	)
}

interface Invited {
	email: string
	password: string
	role: string
}

/**
 * Operator-only: create accounts for teammates. opice ships no mailer, so the
 * password is set here and shown once — copy it and hand it over out of band.
 */
function InvitePeople() {
	const [email, setEmail] = useState('')
	const [name, setName] = useState('')
	const [role, setRole] = useState<'admin' | 'member'>('member')
	const [password, setPassword] = useState(() => generatePassword())
	const [invited, setInvited] = useState<Invited | null>(null)

	const mutation = useMutation({
		mutationFn: () =>
			rpc.admin.createUser({
				email: email.trim(),
				password,
				name: name.trim() || undefined,
				role,
			}),
		onSuccess: () => {
			setInvited({ email: email.trim(), password, role })
		},
	})

	function reset() {
		setInvited(null)
		setEmail('')
		setName('')
		setRole('member')
		setPassword(generatePassword())
		mutation.reset()
	}

	if (invited) {
		return (
			<div className="new-project-panel">
				<div className="np-head">
					<h2>✓ Invited {invited.email}</h2>
					<button type="button" className="btn-ghost" onClick={reset}>Done</button>
				</div>
				<p className="np-warn">Shown once — copy these credentials now and send them to the person securely.</p>

				<label className="np-label">Email</label>
				<CopyBlock value={invited.email} />

				<label className="np-label">Password</label>
				<CopyBlock value={invited.password} />

				<p className="np-hint">
					They sign in at <code>{window.location.origin}</code> and can change this password under Settings.
					Role: <strong>{invited.role}</strong>.
				</p>
			</div>
		)
	}

	const errorMessage = mutation.error
		? mutation.error instanceof RpcError
			? mutation.error.message
			: (mutation.error as Error).message
		: null

	return (
		<form
			className="new-project-panel"
			onSubmit={(e) => {
				e.preventDefault()
				mutation.mutate()
			}}
		>
			<div className="np-head">
				<h2>Invite people</h2>
			</div>
			<p className="np-hint">Create an account for a teammate. They get the email + password below to sign in.</p>

			<label className="np-field">
				<span>Email</span>
				<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" required />
			</label>
			<label className="np-field">
				<span>Name (optional)</span>
				<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" />
			</label>
			<label className="np-field">
				<span>Role</span>
				<select className="np-select" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
					<option value="member">Member — view & manage projects</option>
					<option value="admin">Admin — also manage users & tokens</option>
				</select>
			</label>
			<label className="np-field">
				<span>Password</span>
				<div className="copy-block">
					<code>{password}</code>
					<button type="button" className="copy-btn" onClick={() => setPassword(generatePassword())}>Regenerate</button>
				</div>
			</label>

			{errorMessage && <p className="np-error">{errorMessage}</p>}
			<button type="submit" className="btn-primary" disabled={mutation.isPending}>
				{mutation.isPending ? 'Creating…' : 'Create account'}
			</button>
		</form>
	)
}

/** A readable, copy-pasteable password well over the 10-char minimum. */
function generatePassword(): string {
	const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
	const bytes = new Uint8Array(20)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

function CopyBlock({ value }: { value: string }) {
	const [copied, setCopied] = useState(false)
	async function copy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard blocked (e.g. non-secure context) — the value is still selectable.
		}
	}
	return (
		<div className="copy-block">
			<code>{value}</code>
			<button type="button" className="copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
		</div>
	)
}
