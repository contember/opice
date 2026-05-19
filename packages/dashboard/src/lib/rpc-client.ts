import type { InferRouterClient } from '@opice/worker/rpc'

export class RpcError extends Error {
	readonly type: string
	readonly issues?: unknown
	constructor(payload: { type: string; message: string; issues?: unknown }) {
		super(payload.message)
		this.name = 'RpcError'
		this.type = payload.type
		this.issues = payload.issues
	}
}

async function callRpc(baseUrl: string, method: string, input: unknown): Promise<unknown> {
	const response = await fetch(baseUrl, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ method, input: input ?? null }),
	})
	let data: { result?: unknown; error?: unknown }
	try {
		data = (await response.json()) as { result?: unknown; error?: unknown }
	} catch {
		// Non-JSON response (proxy error, HTML error page, etc.) — surface the
		// HTTP status so the user sees something meaningful instead of nothing.
		throw new RpcError({ type: 'transport', message: `${response.status} ${response.statusText}` })
	}
	if (data.error !== undefined) {
		throw new RpcError(normalizeError(data.error, response.status))
	}
	return data.result
}

function normalizeError(raw: unknown, httpStatus: number): { type: string; message: string; issues?: unknown } {
	if (typeof raw === 'string') {
		return { type: httpStatus === 401 ? 'auth' : 'error', message: raw }
	}
	if (raw && typeof raw === 'object') {
		const e = raw as { type?: unknown; message?: unknown; issues?: unknown }
		return {
			type: typeof e.type === 'string' ? e.type : 'error',
			message: typeof e.message === 'string' ? e.message : 'Unknown error',
			...(e.issues !== undefined ? { issues: e.issues } : {}),
		}
	}
	return { type: 'error', message: `HTTP ${httpStatus}` }
}

function makeProxy(baseUrl: string, path: string): unknown {
	const fn = (input: unknown) => callRpc(baseUrl, path, input)
	return new Proxy(fn, {
		get(_, prop) {
			if (typeof prop !== 'string') return undefined
			return makeProxy(baseUrl, path ? `${path}.${prop}` : prop)
		},
	})
}

export function createRpcClient<TRouter>(opts: { baseUrl: string }): InferRouterClient<TRouter> {
	return makeProxy(opts.baseUrl, '') as InferRouterClient<TRouter>
}
