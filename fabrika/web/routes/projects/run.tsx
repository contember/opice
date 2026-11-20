import { createPage, Link } from '@buzola/router'
import { download } from '@fabrika/app/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Loading } from '../../components/Loading'
import { RunDetail } from '../../components/RunDetail'
import { api } from '../../lib/api'
import { errorMessage } from '../../lib/errors'
import { fmtRelative, shortId } from '../../lib/format'
import { useProject } from '../../lib/project'
import { useCanWrite } from '../../lib/session'

export default createPage()
	.params({ project: 'string', runId: 'string' })
	.route('/p/:project/r/:runId')
	.render(({ params }) => <RunPage projectRef={params.project} runId={params.runId} />)

function RunPage({ projectRef, runId }: { projectRef: string; runId: string }) {
	const project = useProject(projectRef)
	const run = useQuery({
		queryKey: ['runs.get', runId],
		queryFn: () => api.runs.get({ runId }),
	})
	const scenarios = useQuery({
		queryKey: ['runs.scenarios', runId],
		queryFn: async () => (await api.runs.scenarios({ runId })).scenarios,
	})

	if (project.error || run.error) {
		return <div className="error">{errorMessage(project.error ?? run.error)}</div>
	}
	if (project.isLoading || !run.data) {
		return <Loading />
	}
	if (!project.data) {
		return <div className="error">Project not found: {projectRef}</div>
	}

	const r = run.data

	return (
		<>
			<div className="breadcrumb">
				<Link to="index">Projects</Link>
				<span className="sep">/</span>
				<Link to="projects/detail" params={{ project: project.data.slug }}>{project.data.name}</Link>
				<span className="sep">/</span>
				<span>Run {shortId(r.id)}</span>
			</div>

			<RunDetail
				run={r}
				scenarios={scenarios.data}
				scenariosLoading={scenarios.isLoading}
				loadSteps={async scenarioId => (await api.runs.steps({ runId, scenarioId })).steps}
				loadScreenshot={async stepId => URL.createObjectURL(await download(api.runs.screenshot, { runId, stepId }))}
			/>

			<ShareManager runId={r.id} />
		</>
	)
}

/**
 * Share management for an operator holding `project.write`: mints, lists and
 * revokes read-only links to *this run*. The endpoints decide again; hiding the
 * panel only spares a caller without the grant a refusal.
 */
function ShareManager({ runId }: { runId: string }) {
	const canWrite = useCanWrite()
	const queryClient = useQueryClient()
	const [minted, setMinted] = useState<string | null>(null)

	const shares = useQuery({
		queryKey: ['shares.list', runId],
		queryFn: async () => (await api.shares.list({ runId })).shares,
		enabled: canWrite,
	})

	const create = useMutation({
		mutationFn: () => api.shares.create({ runId }),
		onSuccess: ({ url }) => {
			// The link is `/s/#<key>`: the share SPA takes the key out of the fragment.
			setMinted(new URL(url, window.location.origin).toString())
			void queryClient.invalidateQueries({ queryKey: ['shares.list', runId] })
		},
	})

	const revoke = useMutation({
		mutationFn: (linkId: string) => api.shares.revoke({ runId, linkId }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ['shares.list', runId] }),
	})

	if (!canWrite) return null

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
							<code className="share-id">…{shortId(s.id)}</code>
							<span className="share-meta">
								{`expires ${fmtRelative(s.expiresAt)}`}
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
