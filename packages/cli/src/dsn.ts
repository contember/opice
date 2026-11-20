/**
 * An opice DSN packs everything a project needs to report into one string:
 *
 *   OPICE_DSN=https://<key>@<host>/<projectId>
 *
 * The key is a platform service key (`px_…`, minted by an installation administrator in the console), sent as
 * `Authorization: Bearer <key>`; the host is the platform; the first path segment is the project id. The individual
 * `OPICE_*` vars (and opice.config.json) still win when present.
 *
 * Kept in sync with `@opice/harness`'s copy; duplicated to avoid a CLI→harness dependency.
 */
export interface OpiceDsn {
	key: string
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
	const key = decodeURIComponent(url.username)
	const project = url.pathname.replace(/^\/+/, '').split('/')[0] ?? ''
	// A password is the old platform's Access service-token pair, which this platform cannot use.
	if (!key || url.password || !project) return null
	return { key, endpoint: `${url.protocol}//${url.host}`, project }
}
