import { DEV_PERSONA_COOKIE } from './iam'
import type { Env } from './env'
import { handleDashboard } from './routes/dashboard'
import { handleIngest } from './routes/ingest'
import { handleInstallMd } from './routes/install'
import { handleRpc } from './routes/rpc'
import { handleScreenshot } from './routes/screenshots'
import { handleShare } from './routes/share'
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

	// DEV-only operator persona switch: set the FakeIamClient persona cookie, then bounce to the
	// app. Lets local dev / browser tests "sign in as <email>" without Cloudflare Access. 404
	// off-local (no DEV). The local dev-spa (vite) proxies `/__dev/*` to the Worker.
	if (services.config.dev && request.method === 'GET' && path === '/__dev/login') {
		const as = url.searchParams.get('as') ?? ''
		const headers = new Headers({ location: '/' })
		// Path=/ + SameSite=Lax so it rides every navigation + fetch; not HttpOnly (dev only).
		headers.append('set-cookie', `${DEV_PERSONA_COOKIE}=${encodeURIComponent(as)}; Path=/; SameSite=Lax`)
		return new Response(null, { status: 302, headers })
	}
	// ── PUBLIC surfaces (outside Cloudflare Access) ──────────────────────────────
	// Ingest: POST /api/v1/<slug>/runs… — a propustka ingest capability (Bearer).
	if (path.startsWith('/api/v1/')) {
		const segments = path.slice('/api/v1/'.length).split('/').filter(Boolean)
		return handleIngest(request, services, segments)
	}
	if (path === '/install.md') {
		return handleInstallMd(request, services)
	}
	// Share/read surface: /s/rpc, /s/screenshots/*, and the /s/* share SPA shell. A propustka
	// capability token (?token= / opice_read cookie). Anonymous — never behind Access.
	if (path === '/s' || path.startsWith('/s/')) {
		return handleShare(request, services, path === '/s' ? '' : path.slice('/s/'.length))
	}

	// ── OPERATOR surfaces (behind Cloudflare Access) ─────────────────────────────
	if (path === '/rpc') {
		return handleRpc(request, services)
	}
	if (path.startsWith('/screenshots/')) {
		return handleScreenshot(request, services, path.slice('/screenshots/'.length))
	}
	// The operator dashboard SPA shell.
	return handleDashboard(request, services)
}

export type { AppRouter } from './router'
export type { ShareRouter } from './shareRouter'
