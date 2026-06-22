import { forbidden, serveR2Asset } from '../http'
import { opCanReadReports, resolveOperator } from '../principal'
import type { Services } from '../services'

/**
 * Operator R2 asset proxy — behind Cloudflare Access. Serves run artifacts keyed
 * under `<slug>/<runId>/...`: step screenshots (`/screenshots/*`) and scenario
 * walkthrough videos (`/videos/*`). Both share the bucket, the key namespace, and
 * the `report.read` scope check; only the content-type fallback differs. The
 * anonymous share-visitor equivalents are `/s/screenshots/*` / `/s/videos/*`
 * (capability-checked, see routes/share.ts).
 */
async function serveAsset(request: Request, services: Services, key: string, fallbackType: string): Promise<Response> {
	const auth = await resolveOperator(request, services)
	const slug = key.split('/')[0] ?? ''
	if (!auth.ok || slug === '' || !opCanReadReports(auth, slug)) {
		return forbidden()
	}
	return serveR2Asset(services.runAssets, key, fallbackType)
}

export function handleScreenshot(request: Request, services: Services, key: string): Promise<Response> {
	return serveAsset(request, services, key, 'image/png')
}

export function handleVideo(request: Request, services: Services, key: string): Promise<Response> {
	return serveAsset(request, services, key, 'video/webm')
}
