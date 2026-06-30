import { forbidden, json, serveR2Asset } from '../http'
import { capCanReadAssetKey, readAccessRedirect, redeemReadCapability } from '../principal'
import type { Services } from '../services'
import { type ShareContext, shareRouter } from '../shareRouter'
import { dispatchRpcRequest } from '../rpc'

/**
 * The PUBLIC share surface (`/s/*`), OUTSIDE Cloudflare Access. Serves anonymous run-share
 * visitors + machine readers (agent read DSN, stage self-test), all holding a propustka
 * capability token (`?token=` / `opice_read` cookie). Three sub-paths:
 *   - `/s/rpc`            → the read-only share RPC (redeem the capability, run/project-scoped reads)
 *   - `/s/screenshots/*`  → R2 proxy, capability-checked
 *   - `/s/videos/*`       → R2 proxy for scenario walkthrough videos, capability-checked
 *   - `/s/*` (everything else) → the dashboard SPA shell (the `?token=`→cookie exchange runs here)
 */
export async function handleShare(request: Request, services: Services, subPath: string): Promise<Response> {
	if (subPath === 'rpc') {
		return handleShareRpc(request, services)
	}
	if (subPath.startsWith('screenshots/')) {
		return handleShareAsset(request, services, subPath.slice('screenshots/'.length), 'image/png')
	}
	if (subPath.startsWith('videos/')) {
		return handleShareAsset(request, services, subPath.slice('videos/'.length), 'video/webm')
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

/**
 * Capability-checked R2 proxy for a run asset (`<slug>/<runId>/...`) — step
 * screenshots and scenario videos alike, told apart only by the content-type
 * fallback. The visitor's run-share/read capability must cover the key's run.
 */
async function handleShareAsset(request: Request, services: Services, key: string, fallbackType: string): Promise<Response> {
	const cap = await redeemReadCapability(request, services)
	if (!cap || !capCanReadAssetKey(cap, key)) {
		return forbidden()
	}
	return serveR2Asset(services.runAssets, key, fallbackType)
}
