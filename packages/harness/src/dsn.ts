/**
 * An opice DSN packs everything a project needs to report into one string:
 *
 *   OPICE_DSN=https://<clientId>:<clientSecret>@<host>/<slug>
 *
 * The DSN is a Cloudflare Access SERVICE TOKEN: the client id + secret ride in the
 * userinfo (sent as the `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers),
 * the host is the platform endpoint, and the first path segment is the project slug.
 * It's the single value the dashboard hands you to drop into `.env`; the individual
 * `OPICE_*` vars still win when set, so a DSN is purely a convenience fallback.
 */
export interface OpiceDsn {
	clientId: string
	clientSecret: string
	endpoint: string
	project: string
}

export function parseOpiceDsn(raw: string | undefined | null): OpiceDsn | null {
	if (!raw) return null
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return null
	}
	const clientId = decodeURIComponent(url.username)
	const clientSecret = decodeURIComponent(url.password)
	const project = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
	if (!clientId || !clientSecret || !project) return null
	return { clientId, clientSecret, endpoint: `${url.protocol}//${url.host}`, project }
}
