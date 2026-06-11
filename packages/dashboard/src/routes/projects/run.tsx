import { createPage, Link } from '@buzola/router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loading } from '../../components/Loading'
import { RunDetail } from '../../components/RunDetail'
import { rpc } from '../../lib/client'
import { fmtRelative } from '../../lib/format'
import { useMe } from '../../lib/session'

export default createPage()
	.params({ slug: 'string', runId: 'string' })
	.route('/p/:slug/r/:runId')
	.render(({ params }) => <RunPage slug={params.slug} runId={params.runId} />)

function RunPage({ slug, runId }: { slug: string; runId: string }) {
	const project = useQuery({
		queryKey: ['projects.get', slug],
		queryFn: () => rpc.projects.get({ slug }),
	})
	const run = useQuery({
		queryKey: ['runs.get', runId],
		queryFn: () => rpc.runs.get({ runId }),
	})
	const scenarios = useQuery({
		queryKey: ['runs.scenarios', runId],
		queryFn: () => rpc.runs.scenarios({ runId }),
	})

	if (project.error || run.error) {
		return <div className="error">{((project.error ?? run.error) as Error).message}</div>
	}
	if (!project.data || !run.data) {
		return <Loading />
	}

	const r = run.data

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<Link to="projects/detail" params={{ slug }}>{project.data.name}</Link>
				<span className="sep">/</span>
				<span>Run {r.id.slice(0, 8)}</span>
			</div>

			<RunDetail
				run={r}
				scenarios={scenarios.data}
				scenariosLoading={scenarios.isLoading}
				loadSteps={scenarioId => rpc.scenarios.steps({ scenarioId })}
			/>

			<ShareManager slug={slug} runId={r.id} />
		</>
	)
}

/**
 * Operator-only share management. Mints/lists/revokes read-only links scoped to
 * *this run*. Hidden for share-link visitors (anonymous, canCreateProjects=false)
 * — they already arrived via such a link, and the `shares.*` RPCs require the
 * `project.write` capability they don't have.
 */
function ShareManager({ slug, runId }: { slug: string; runId: string }) {
	const { data: me } = useMe()
	const queryClient = useQueryClient()
	const origin = typeof window !== 'undefined' ? window.location.origin : ''
	const [minted, setMinted] = useState<string | null>(null)

	const shares = useQuery({
		queryKey: ['shares.list', runId],
		queryFn: () => rpc.shares.list({ runId }),
		enabled: !!me?.canCreateProjects,
	})

	const create = useMutation({
		mutationFn: () => rpc.shares.create({ runId }),
		onSuccess: ({ token }) => {
			// The PUBLIC share view, outside Cloudflare Access. The `?token=` is
			// exchanged for the read cookie by the Worker before the SPA loads.
			setMinted(`${origin}/s/p/${slug}/r/${runId}?token=${token}`)
			queryClient.invalidateQueries({ queryKey: ['shares.list', runId] })
		},
	})

	const revoke = useMutation({
		mutationFn: (shareId: string) => rpc.shares.revoke({ shareId }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares.list', runId] }),
	})

	// Share-link visitors (anonymous) and non-operator callers don't manage shares.
	if (!me?.canCreateProjects) return null

	return (
		<div className="share-link">
			<div className="share-head">
				<span className="share-label">Read-only links</span>
				<button type="button" className="share-copy" onClick={() => create.mutate()} disabled={create.isPending}>
					{create.isPending ? 'Creating…' : '+ Create link'}
				</button>
			</div>

			{minted && (
				<div className="share-minted">
					<CopyUrl url={minted} />
					<span className="share-hint">Shown once — copy it now. It grants read-only access to this run only.</span>
				</div>
			)}

			{shares.data && shares.data.length > 0 ? (
				<ul className="share-list">
					{shares.data.map(s => (
						<li key={s.id} className="share-row">
							<code className="share-id">{s.id.slice(0, 8)}…</code>
							<span className="share-meta">
								{s.expiresAt ? `expires ${fmtRelative(s.expiresAt)}` : 'no expiry'}
							</span>
							<button
								type="button"
								className="share-copy"
								onClick={() => revoke.mutate(s.id)}
								disabled={revoke.isPending}
							>
								Revoke
							</button>
						</li>
					))}
				</ul>
			) : (
				<span className="share-hint">No active share links. Anyone with a link can view this run read-only.</span>
			)}
		</div>
	)
}

function CopyUrl({ url }: { url: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () => {
		void navigator.clipboard.writeText(url).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}
	return (
		<div className="share-copy-row">
			<code className="share-url">{url}</code>
			<button type="button" className="share-copy" onClick={copy}>
				{copied ? 'Copied' : 'Copy'}
			</button>
		</div>
	)
}
