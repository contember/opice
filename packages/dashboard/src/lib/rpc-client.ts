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
	const data = (await response.json()) as { result?: unknown; error?: { type: string; message: string; issues?: unknown } }
	if (data.error) {
		throw new RpcError(data.error)
	}
	return data.result
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
