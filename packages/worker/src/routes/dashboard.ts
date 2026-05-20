import { readAccessRedirect, resolveReadScope } from '../read-gate'
import type { Services } from '../services'

const GATE_HTML = `<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:60px auto;color:#444;">
<h1>🐒 opice</h1>
<p>This dashboard is read-token gated. Append <code>?token=YOUR_TOKEN</code> to the URL to access.</p>
</body></html>`

export async function handleDashboard(request: Request, services: Services): Promise<Response> {
	const redirect = await readAccessRedirect(request, services)
	if (redirect) return redirect
	if (!(await resolveReadScope(request, services))) {
		return new Response(GATE_HTML, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
	}
	return services.assets.fetch(request)
}
