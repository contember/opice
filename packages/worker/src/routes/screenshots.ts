import { forbidden, notFound } from '../http'
import { canSeeScreenshotKey, resolveCaller } from '../principal'
import type { Services } from '../services'

export async function handleScreenshot(request: Request, services: Services, key: string): Promise<Response> {
	const resolved = await resolveCaller(request, services)
	if (!resolved.ok || !canSeeScreenshotKey(resolved.caller, key)) {
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
