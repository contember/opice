// The operator routes, written out by hand: buzola's codegen emits type assertions the checker refuses, and five pages
// need no lazy loading.
import { buildRouteTree, type RouteConfig } from '@buzola/router'
import Layout from './routes/_layout'
import IndexPage from './routes/index'
import ProjectPage from './routes/projects/detail'
import RunPage from './routes/projects/run'
import RunsPage from './routes/runs'
import SettingsPage from './routes/settings'

declare module '@buzola/router' {
	interface BuzolaPageMap {
		index: Record<never, never>
		'projects/detail': { project: string }
		'projects/run': { project: string; runId: string }
		runs: Record<never, never>
		settings: Record<never, never>
	}
}

/** Page id → route pattern, for `<Link to>`. */
export const pageRegistry: Record<string, string> = {
	index: '/',
	'projects/detail': '/p/:project',
	'projects/run': '/p/:project/r/:runId',
	runs: '/runs',
	settings: '/settings',
}

const routeConfigs: RouteConfig[] = [
	{
		path: '/',
		component: Layout,
		isLayout: true,
		children: [
			{ path: '/', component: IndexPage.component, isIndex: true },
			{ path: '/projects/detail', matchPath: '/p/:project', component: ProjectPage.component },
			{ path: '/projects/run', matchPath: '/p/:project/r/:runId', component: RunPage.component },
			{ path: '/runs', component: RunsPage.component },
			{ path: '/settings', component: SettingsPage.component },
		],
	},
]

export const routes = buildRouteTree(routeConfigs)
