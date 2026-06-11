import { forbidden, notFound } from '../http'
import { opCanReadReports, resolveOperator } from '../principal'
import type { Services } from '../services'

/**
 * Operator screenshot proxy (`/screenshots/<slug>/<runId>/...`) — behind Cloudflare Access.
 * The anonymous share-visitor equivalent is `/s/screenshots/*` (capability-checked, see
 * routes/share.ts).
 */
export async function handleScreenshot(request: Request, services: Services, key: string): Promise<Response> {
	const auth = await resolveOperator(request, services)
	const slug = key.split('/')[0] ?? ''
	if (!auth.ok || slug === '' || !opCanReadReports(auth, slug)) {
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
