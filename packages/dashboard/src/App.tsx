import { Layout } from './components/Layout'
import { matchRoute, usePathname } from './lib/router'
import { ProjectPage } from './pages/Project'
import { ProjectsPage } from './pages/Projects'
import { RunPage } from './pages/Run'

export function App() {
	const pathname = usePathname()
	const match = matchRoute(pathname)

	return (
		<Layout>
			{match.page === 'home' && <ProjectsPage />}
			{match.page === 'project' && <ProjectPage slug={match.params['slug']!} />}
			{match.page === 'run' && <RunPage slug={match.params['slug']!} runId={match.params['runId']!} />}
			{match.page === 'notfound' && <div className="empty">Page not found.</div>}
		</Layout>
	)
}
