import { hasReadAccess, readAccessRedirect } from '../read-gate'
import type { Services } from '../services'

const GATE_HTML = `<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;color:#444;">
<h1>🐒 opice</h1>
<p>This dashboard is read-token gated. Append <code>?token=YOUR_TOKEN</code> to the URL to access.</p>
</body></html>`

export function handleDashboard(request: Request, services: Services): Response | Promise<Response> {
	const redirect = readAccessRedirect(request, services.config.readToken)
	if (redirect) return redirect
	if (!hasReadAccess(request, services.config.readToken)) {
		return new Response(GATE_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
	}
	return services.assets.fetch(request)
}
