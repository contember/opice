/**
 * An opice DSN packs everything a project needs to report into one string:
 *
 *   OPICE_DSN=https://<apiKey>@<host>/<slug>
 *
 * The api key rides in the userinfo, the host is the platform endpoint, and
 * the first path segment is the project slug. The individual `OPICE_*` vars
 * (and opice.config.json) still win when present — the DSN is a convenience
 * fallback so the dashboard can hand out a single value to drop into `.env`.
 *
 * Kept in sync with `@opice/harness`'s copy; duplicated to avoid a CLI→harness
 * dependency.
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
