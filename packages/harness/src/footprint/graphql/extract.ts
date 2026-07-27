/** Request body → GraphQL documents: recognising the request and unpacking it. */

export interface ExtractedQueries {
	/** Query documents found in the request, each with the operation the client selected (if any). */
	documents: { query: string; operationName?: string }[]
	/**
	 * Count of persisted queries (an APQ hash with no document). Their fields are
	 * unrecoverable client-side — the collector warns rather than reporting an
	 * empty operation as if the scenario touched nothing.
	 */
	persisted: number
}

/**
 * Pull GraphQL documents out of a request body. Handles the three shapes in the
 * wild: a single JSON `{query, operationName}`, a JSON array (batched), and a
 * raw `application/graphql` body.
 */
export function extractQueries(body: string | undefined, contentType?: string): ExtractedQueries {
	const empty: ExtractedQueries = { documents: [], persisted: 0 }
	if (!body) return empty
	const ct = (contentType ?? '').toLowerCase()
	if (ct.includes('application/graphql')) {
		return { documents: [{ query: body }], persisted: 0 }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(body)
	} catch {
		return empty
	}
	const entries = Array.isArray(parsed) ? parsed : [parsed]
	const documents: { query: string; operationName?: string }[] = []
	let persisted = 0
	for (const entry of entries) {
		if (typeof entry !== 'object' || entry === null) continue
		const record = entry as Record<string, unknown>
		const query = record['query']
		const operationName = typeof record['operationName'] === 'string' ? record['operationName'] : undefined
		if (typeof query === 'string' && query.trim()) {
			documents.push(operationName ? { query, operationName } : { query })
		} else if (hasPersistedQuery(record)) {
			persisted++
		}
	}
	return { documents, persisted }
}

/** An Apollo automatic-persisted-query request: a hash instead of the document. */
function hasPersistedQuery(record: Record<string, unknown>): boolean {
	const extensions = record['extensions']
	if (typeof extensions !== 'object' || extensions === null) return false
	return 'persistedQuery' in (extensions as Record<string, unknown>)
}

/**
 * Does this request look like GraphQL? A path ending in `/graphql` is the
 * convention; a JSON body carrying a `query` string is the fallback for the
 * apps that mount it elsewhere (`/api`, `/v1/content`).
 */
export function looksLikeGraphql(pathname: string, body: string | undefined, contentType?: string): boolean {
	if (/\/graphql\b/i.test(pathname)) return true
	if ((contentType ?? '').toLowerCase().includes('application/graphql')) return true
	if (!body) return false
	// No size limit of its own. It used to stop at a megabyte, which quietly
	// answered "not GraphQL" for a body the COLLECTOR was willing to scan (its
	// limit is 2 MiB) — so such a request was neither parsed nor counted as
	// unreadable, and the models read as an authoritative empty set. One limit,
	// enforced in one place, is the only way those two agree.
	if (!body.includes('"query"') && !body.includes('"operationName"')) return false
	return /["']\s*(query|operationName)\s*["']\s*:/.test(body)
}
