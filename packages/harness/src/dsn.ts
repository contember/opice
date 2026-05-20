/**
 * An opice DSN packs everything a project needs to report into one string:
 *
 *   OPICE_DSN=https://<apiKey>@<host>/<slug>
 *
 * The api key rides in the userinfo, the host is the platform endpoint, and
 * the first path segment is the project slug. It's the single value the
 * dashboard hands you to drop into `.env`; the individual `OPICE_*` vars still
 * win when set, so a DSN is purely a convenience fallback.
 */
export interface OpiceDsn {
	apiKey: string
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
	const apiKey = decodeURIComponent(url.username)
	const project = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
	if (!apiKey || !project) return null
	return { apiKey, endpoint: `${url.protocol}//${url.host}`, project }
}
