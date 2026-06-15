/**
 * An opice DSN packs everything a project needs to report into one string:
 *
 *   OPICE_DSN=https://<clientId>:<clientSecret>@<host>/<slug>
 *
 * The DSN is a Cloudflare Access SERVICE TOKEN: the client id + secret ride in the
 * userinfo (sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`), the host is
 * the platform endpoint, and the first path segment is the project slug. The
 * individual `OPICE_*` vars (and opice.config.json) still win when present — the DSN
 * is a convenience fallback so the dashboard can hand out a single value.
 *
 * Kept in sync with `@opice/harness`'s copy; duplicated to avoid a CLI→harness
 * dependency.
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
