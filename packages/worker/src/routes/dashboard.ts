import { readAccessRedirect } from '../principal'
import type { Services } from '../services'

/**
 * Serve the dashboard SPA shell.
 *
 * The shell (HTML/JS/CSS) is intentionally public: an anonymous share-link visitor must be able
 * to load it. Operator identity comes from Cloudflare Access (the edge), and the data stays gated
 * server-side at `/rpc` + `/screenshots`, so there's nothing sensitive in the shell itself.
 *
 * We still honour `?token=` run-share links by exchanging them for the read cookie before serving
 * (so the capability-token secret leaves the address bar and then rides every `/rpc` call).
 */
export async function handleDashboard(request: Request, services: Services): Promise<Response> {
	const redirect = await readAccessRedirect(request, services)
	if (redirect) return redirect
	return services.assets.fetch(request)
}
