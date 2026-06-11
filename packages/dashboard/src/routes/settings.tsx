import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { CopyBlock } from '../components/NewProject'
import { rpc } from '../lib/client'
import { fmtRelative } from '../lib/format'
import { useMe } from '../lib/session'

export default createPage()
	.route('/settings')
	.render(() => <SettingsPage />)

function SettingsPage() {
	const { data: me, isPending } = useMe()

	if (isPending) return null
	// Only operators reach the settings route (it lives behind AuthGate), but
	// keep a defensive guard for the brief pending-resolved window.
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

			{me.canCreateProjects && <ProjectKeys />}
		</>
	)
}

/**
 * Per-project DSN capabilities (ingest + read), listed and revocable. The keys
 * themselves are propustka capability tokens minted at project-create time and
 * shown once — this view only carries their metadata mirror, so it can name and
 * revoke them but never re-display the secret.
 */
function ProjectKeys() {
	const queryClient = useQueryClient()
	const [slug, setSlug] = useState('')
	const [minted, setMinted] = useState<{ kind: 'ingest' | 'read'; token: string } | null>(null)

	const projects = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => rpc.projects.list(),
	})

	const keys = useQuery({
		queryKey: ['projects.listKeys', slug],
		queryFn: () => rpc.projects.listKeys({ slug }),
		enabled: !!slug,
	})

	const revoke = useMutation({
		mutationFn: (capabilityId: string) => rpc.projects.revokeKey({ capabilityId }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects.listKeys', slug] }),
	})

	const rotate = useMutation({
		mutationFn: (kind: 'ingest' | 'read') => rpc.projects.rotateKey({ slug, kind }),
		onSuccess: (result, kind) => {
			setMinted({ kind, token: result.token })
			queryClient.invalidateQueries({ queryKey: ['projects.listKeys', slug] })
		},
	})

	function pick(next: string) {
		setSlug(next)
		setMinted(null)
		rotate.reset()
	}

	return (
		<div className="new-project-panel">
			<div className="np-head">
				<h2>Project keys</h2>
			</div>
			<p className="np-hint">
				The DSN capabilities a project hands out — an ingest key for CI (<code>OPICE_DSN</code>)
				and a read key for the authoring agent (<code>OPICE_READ_DSN</code>). Revoke one to cut
				it off; mint fresh keys by recreating them at project setup.
			</p>

			<label className="np-field">
				<span>Project</span>
				<select className="np-select" value={slug} onChange={e => pick(e.target.value)}>
					<option value="">Select a project…</option>
					{projects.data?.map(p => (
						<option key={p.slug} value={p.slug}>{p.name} ({p.slug})</option>
					))}
				</select>
			</label>

			{slug && (
				keys.isLoading ? (
					<span className="np-hint">Loading keys…</span>
				) : keys.data && keys.data.length > 0 ? (
					<ul className="share-list">
						{keys.data.map(k => (
							<li key={k.id} className="share-row">
								<code className="share-id">{k.id.slice(0, 8)}…</code>
								<span className="share-meta">
									{k.label ?? '(no label)'} · {k.kind}
									{k.expiresAt ? ` · expires ${fmtRelative(k.expiresAt)}` : ''}
								</span>
								<button
									type="button"
									className="share-copy"
									onClick={() => revoke.mutate(k.id)}
									disabled={revoke.isPending}
								>
									Revoke
								</button>
							</li>
						))}
					</ul>
				) : (
					<span className="np-hint">No active keys for this project.</span>
				)
			)}

			{slug && (
				<>
					<div className="np-actions">
						<button
							type="button"
							className="btn-primary"
							onClick={() => rotate.mutate('ingest')}
							disabled={rotate.isPending}
						>
							Mint / rotate ingest DSN
						</button>
						<button
							type="button"
							className="btn-primary"
							onClick={() => rotate.mutate('read')}
							disabled={rotate.isPending}
						>
							Mint / rotate read DSN
						</button>
					</div>

					{minted && (
						<>
							<p className="np-warn">Shown once — store it now (it embeds a secret key that can't be recovered).</p>
							<CopyBlock
								value={
									minted.kind === 'ingest'
										? `OPICE_DSN=https://${minted.token}@${window.location.host}/${slug}`
										: `OPICE_READ_DSN=https://${minted.token}@${window.location.host}/${slug}`
								}
							/>
							<p className="np-hint">
								{minted.kind === 'ingest'
									? <>Write key — CI and local <code>opice test</code> stream results with it.</>
									: <>Read key — lets the authoring agent pull this project's results back (e.g. <code>opice failures</code>, re-eval). Scoped to this project, read-only.</>}
							</p>
						</>
					)}
				</>
			)}
		</div>
	)
}
