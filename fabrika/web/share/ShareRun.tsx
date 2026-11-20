import { download } from '@fabrika/app/client'
import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Loading } from '../components/Loading'
import { Logo } from '../components/Logo'
import { RunDetail } from '../components/RunDetail'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { errorMessage } from '../lib/errors'
import { shortId } from '../lib/format'
import type { ShareClient } from './client'

/**
 * The anonymous, read-only view of the ONE run a share link names. Everything goes through the link mount's client —
 * never the operator surface. Reuses the same `RunDetail` renderer as the operator run page.
 */
export function ShareRun({ client }: { client: ShareClient }) {
	const run = useQuery({
		queryKey: ['shared.run'],
		queryFn: () => client.run(),
	})
	const scenarios = useQuery({
		queryKey: ['shared.scenarios'],
		queryFn: async () => (await client.scenarios()).scenarios,
	})

	return (
		<ShareShell>
			{run.error ? (
				<div className="error">{errorMessage(run.error)}</div>
			) : !run.data ? (
				<Loading />
			) : (
				<>
					<div className="breadcrumb">
						<span>Shared run</span>
						<span className="sep">/</span>
						<span>Run {shortId(run.data.id)}</span>
					</div>
					<RunDetail
						run={run.data}
						scenarios={scenarios.data}
						scenariosLoading={scenarios.isLoading}
						loadSteps={async scenarioId => (await client.steps({ scenarioId })).steps}
						loadScreenshot={async stepId => URL.createObjectURL(await download(client.screenshot, { stepId }))}
					/>
				</>
			)}
		</ShareShell>
	)
}

/** A page opened without a link key: nothing to read. */
export function NoLink() {
	return (
		<ShareShell>
			<div className="empty">
				<div className="empty-title">This link carries no key</div>
				<div className="empty-body">Open the full share link you were given.</div>
			</div>
		</ShareShell>
	)
}

/** Public share shell — no operator chrome, no project nav, no sign-out. */
function ShareShell({ children }: { children: ReactNode }) {
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
			<main className="wide">{children}</main>
			<ThemeSwitcher />
		</>
	)
}
