import { createPage } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { Loading } from '../components/Loading'
import { RunDetail } from '../components/RunDetail'
import { shareRpc } from '../lib/share-client'

export default createPage()
	.params({ slug: 'string', runId: 'string' })
	.route('/s/p/:slug/r/:runId')
	.render(({ params }) => <ShareRunPage slug={params.slug} runId={params.runId} />)

/**
 * The anonymous, read-only share view of ONE run. Everything goes through the
 * share RPC client (`/s/rpc`) — never the operator `/rpc` surface — so it works
 * for a visitor with no Cloudflare Access session, only a redeemed read cookie.
 * Reuses the same `RunDetail` renderer as the operator run page.
 */
function ShareRunPage({ slug, runId }: { slug: string; runId: string }) {
	const project = useQuery({
		queryKey: ['share.projects.get', slug],
		queryFn: () => shareRpc.projects.get({ slug }),
	})
	const run = useQuery({
		queryKey: ['share.runs.get', runId],
		queryFn: () => shareRpc.runs.get({ runId }),
	})
	const scenarios = useQuery({
		queryKey: ['share.runs.scenarios', runId],
		queryFn: () => shareRpc.runs.scenarios({ runId }),
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
				<span>{project.data.name}</span>
				<span className="sep">/</span>
				<span>Run {r.id.slice(0, 8)}</span>
			</div>

			<RunDetail
				run={r}
				scenarios={scenarios.data}
				scenariosLoading={scenarios.isLoading}
				loadSteps={scenarioId => shareRpc.scenarios.steps({ scenarioId })}
			/>
		</>
	)
}
