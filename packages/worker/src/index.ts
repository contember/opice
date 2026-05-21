import type { Env } from './env'
import { handleAdmin } from './routes/admin'
import { handleAuth } from './routes/auth'
import { handleDashboard } from './routes/dashboard'
import { handleIngest } from './routes/ingest'
import { handleInstallMd } from './routes/install'
import { handleRpc } from './routes/rpc'
import { handleScreenshot } from './routes/screenshots'
import { buildServices, type Services } from './services'

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const services = buildServices(env)
		return route(request, services)
	},

	// Cron (see triggers.crons in oblaka.ts): finalize runs abandoned mid-flight
	// so they stop reading as "running" forever. Reads already show stale runs
	// as 'incomplete' lazily; this persists that and sets finished_at.
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const services = buildServices(env)
		ctx.waitUntil(services.db.reapStaleRuns())
	},
}

async function route(request: Request, services: Services): Promise<Response> {
	const url = new URL(request.url)
	const path = url.pathname

	if (path.startsWith('/auth/')) {
		return handleAuth(request, services, path.slice('/auth/'.length))
	}
	if (path.startsWith('/api/v1/admin/')) {
		const segments = path.slice('/api/v1/admin/'.length).split('/').filter(Boolean)
		return handleAdmin(request, services, segments)
	}
	if (path.startsWith('/api/v1/')) {
		const segments = path.slice('/api/v1/'.length).split('/').filter(Boolean)
		return handleIngest(request, services, segments)
	}
	if (path === '/install.md') {
		return handleInstallMd(request, services)
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
