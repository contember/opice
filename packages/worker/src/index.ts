import { handleApi } from './api'
import { hasReadAccess, readAccessRedirect } from './auth'
import { Db } from './db'
import { appRouter } from './router'
import { dispatchRpcRequest } from './rpc'

interface Env {
	DB: D1Database
	SCREENSHOTS: R2Bucket
	ASSETS: Fetcher
	READ_TOKEN: string
	ADMIN_TOKEN: string
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const path = url.pathname

		// Ingest API (used by @opice/harness CI).
		if (path.startsWith('/api/v1/')) {
			const segments = path.slice('/api/v1/'.length).split('/').filter(Boolean)
			return handleApi(request, env, new Db(env.DB), segments)
		}

		// RPC endpoint for the dashboard SPA.
		if (path === '/rpc') {
			if (request.method !== 'POST') {
				return new Response('method not allowed', { status: 405 })
			}
			if (!hasReadAccess(request, env.READ_TOKEN)) {
				return new Response(JSON.stringify({ error: { type: 'auth', message: 'forbidden' } }), {
					status: 401,
					headers: { 'content-type': 'application/json' },
				})
			}
			return dispatchRpcRequest({
				router: appRouter,
				buildContext: () => ({ db: new Db(env.DB) }),
				request,
			})
		}

		// Screenshot proxy from R2.
		if (path.startsWith('/screenshots/')) {
			if (!hasReadAccess(request, env.READ_TOKEN)) {
				return new Response('forbidden', { status: 403 })
			}
			const key = path.slice('/screenshots/'.length)
			const obj = await env.SCREENSHOTS.get(key)
			if (!obj) {
				return new Response('not found', { status: 404 })
			}
			return new Response(obj.body, {
				headers: {
					'content-type': obj.httpMetadata?.contentType ?? 'image/png',
					'cache-control': 'public, max-age=3600',
				},
			})
		}

		// Read-token redirect (sets cookie, drops token from URL).
		const redirect = readAccessRedirect(request, env.READ_TOKEN)
		if (redirect) return redirect

		if (!hasReadAccess(request, env.READ_TOKEN)) {
			return new Response(
				`<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;color:#444;">
<h1>🐒 opice</h1>
<p>This dashboard is read-token gated. Append <code>?token=YOUR_TOKEN</code> to the URL to access.</p>
</body></html>`,
				{ status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } },
			)
		}

		// Everything else → SPA assets (Vite build).
		return env.ASSETS.fetch(request)
	},
}

export type { AppRouter } from './router'
