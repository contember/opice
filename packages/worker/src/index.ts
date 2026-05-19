import type { Env } from './env'
import { handleAdmin } from './routes/admin'
import { handleDashboard } from './routes/dashboard'
import { handleIngest } from './routes/ingest'
import { handleRpc } from './routes/rpc'
import { handleScreenshot } from './routes/screenshots'
import { buildServices, type Services } from './services'

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const services = buildServices(env)
		return route(request, services)
	},
}

async function route(request: Request, services: Services): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname

	if (path.startsWith('/api/v1/admin/')) {
		const segments = path.slice('/api/v1/admin/'.length).split('/').filter(Boolean)
		return handleAdmin(request, services, segments)
	}
	if (path.startsWith('/api/v1/')) {
		const segments = path.slice('/api/v1/'.length).split('/').filter(Boolean)
		return handleIngest(request, services, segments)
	}
	if (path === '/rpc') {
		return handleRpc(request, services)
	}
	if (path.startsWith('/screenshots/')) {
		return handleScreenshot(request, services, path.slice('/screenshots/'.length))
	}
	return handleDashboard(request, services)
}

export type { AppRouter } from './router'
