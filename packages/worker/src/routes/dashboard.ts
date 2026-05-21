import { readAccessRedirect } from '../principal'
import type { Services } from '../services'

/**
 * Serve the dashboard SPA shell.
 *
 * The shell (HTML/JS/CSS) is intentionally public: it renders the sign-in
 * screen for anonymous visitors and the app for an authenticated session or a
 * valid read-token cookie. The actual data stays gated server-side at `/rpc`
 * and `/screenshots`, so there's nothing sensitive to protect here — and
 * gating the HTML itself would hide the login form from logged-out users.
 *
 * We still honour `?token=` links by exchanging them for the read cookie
 * (shareable read-only views) before serving.
 */
export async function handleDashboard(request: Request, services: Services): Promise<Response> {
	const redirect = await readAccessRedirect(request, services)
	if (redirect) return redirect
	return services.assets.fetch(request)
}
