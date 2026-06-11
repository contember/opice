import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { rpc } from '../lib/client'
import { RpcError } from '../lib/rpc-client'
import { useMe } from '../lib/session'

export default createPage()
	.route('/settings')
	.render(() => <SettingsPage />)

function SettingsPage() {
	const { data: me, isPending } = useMe()

	if (isPending) return null
	// Share-link visitors (anonymous, not authenticated) have no account to manage.
	if (!me?.authenticated) {
		return <div className="error">You don't have access to settings.</div>
	}

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
					Signed in as <code>{me.email}</code>
				</div>
			</div>

			{me.canManageTokens && <TokenManager />}
			{!me.canManageTokens && (
				<div className="error">You don't have access to token management.</div>
			)}
		</>
	)
}

interface TokenSummary {
	id: string
	capability: 'read' | 'write' | 'admin'
	projectSlug: string | null
	label: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
}

/**
 * Token manager: the full data-plane token inventory + minting. The headline
 * use is a project-scoped *read* token an authoring agent drops into `.env`
 * as OPICE_READ_DSN to pull results back — available here after the fact and
 * for existing projects.
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
						const scope = t.projectSlug ?? 'all projects'
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
