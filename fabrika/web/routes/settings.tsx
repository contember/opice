import { createPage, Link } from '@buzola/router'
import { useQuery } from '@tanstack/react-query'
import { CopyBlock } from '../components/NewProject'
import { api } from '../lib/api'
import { useMe } from '../lib/session'

export default createPage()
	.route('/settings')
	.render(() => <SettingsPage />)

function SettingsPage() {
	const { data: me, isPending } = useMe()

	if (isPending) return null
	if (!me) return <div className="error">You don't have access to settings.</div>

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

			<ProjectKeys />
		</>
	)
}

/**
 * Where a project's DSN comes from. The platform mints no keys itself: an installation administrator creates a `px_`
 * service key in the console and grants it in the project, and the DSN names the project by its id.
 */
function ProjectKeys() {
	const projects = useQuery({
		queryKey: ['projects.list'],
		queryFn: () => api.projects.list(),
	})
	const host = window.location.host

	return (
		<div className="new-project-panel">
			<div className="np-head">
				<h2>Project keys</h2>
			</div>
			<p className="np-hint">
				An installation administrator mints <code>px_</code> service keys in the platform console (Access →
				Credentials) and grants <code>report.write</code> in the project for CI (<code>OPICE_DSN</code>), or{' '}
				<code>report.read</code> for the authoring agent (<code>OPICE_READ_DSN</code>). Revoke a key there.
			</p>
			{projects.data?.projects.map(p => (
				<div key={p.id}>
					<label className="np-label">{p.name} <code>{p.slug}</code></label>
					<CopyBlock value={`OPICE_DSN=https://<service key>@${host}/${p.id}`} />
				</div>
			))}
		</div>
	)
}
