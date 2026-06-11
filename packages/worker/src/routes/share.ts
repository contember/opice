import { forbidden, json, notFound } from '../http'
import { capCanReadScreenshotKey, readAccessRedirect, redeemReadCapability } from '../principal'
import type { Services } from '../services'
import { type ShareContext, shareRouter } from '../shareRouter'
import { dispatchRpcRequest } from '../rpc'

/**
 * The PUBLIC share surface (`/s/*`), OUTSIDE Cloudflare Access. Serves anonymous run-share
 * visitors + machine readers (agent read DSN, stage self-test), all holding a propustka
 * capability token (`?token=` / `opice_read` cookie). Three sub-paths:
 *   - `/s/rpc`            → the read-only share RPC (redeem the capability, run/project-scoped reads)
 *   - `/s/screenshots/*`  → R2 proxy, capability-checked
 *   - `/s/*` (everything else) → the dashboard SPA shell (the `?token=`→cookie exchange runs here)
 */
export async function handleShare(request: Request, services: Services, subPath: string): Promise<Response> {
	if (subPath === 'rpc') {
		return handleShareRpc(request, services)
	}
	if (subPath.startsWith('screenshots/')) {
		return handleShareScreenshot(request, services, subPath.slice('screenshots/'.length))
	}
	// The share SPA shell. Exchange a `?token=` for the read cookie first, then serve assets.
	const redirect = await readAccessRedirect(request, services)
	if (redirect) return redirect
	return services.assets.fetch(request)
}

async function handleShareRpc(request: Request, services: Services): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 })
	}
	const cap = await redeemReadCapability(request, services)
	if (!cap) {
		// A share link reads as 404 when its token is invalid/expired/revoked — never a leaky 401/403.
		return json({ error: { type: 'not_found', message: 'invalid or expired link' } }, { status: 404 })
	}
	return dispatchRpcRequest<ShareContext>({
		router: shareRouter,
		buildContext: () => ({ services, cap }),
		request,
	})
}

async function handleShareScreenshot(request: Request, services: Services, key: string): Promise<Response> {
	const cap = await redeemReadCapability(request, services)
	if (!cap || !capCanReadScreenshotKey(cap, key)) {
		return forbidden()
	}
	const obj = await services.screenshots.get(key)
	if (!obj) {
		return notFound()
	}
	return new Response(obj.body, {
		headers: {
			'content-type': obj.httpMetadata?.contentType ?? 'image/png',
			'cache-control': 'public, max-age=3600',
		},
	})
}
