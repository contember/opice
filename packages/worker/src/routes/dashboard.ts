import type { Services } from '../services'

/**
 * Serve the OPERATOR dashboard SPA shell — behind Cloudflare Access. (The anonymous share-link
 * SPA + its `?token=`→cookie exchange live on the public `/s/*` surface; see routes/share.ts.)
 * The shell carries no data; everything is gated server-side at `/rpc` + `/screenshots`.
 */
export function handleDashboard(request: Request, services: Services): Promise<Response> {
	return services.assets.fetch(request)
}
