import { json } from '../http'
import { resolveCaller } from '../principal'
import { appRouter, type RpcContext } from '../router'
import { dispatchRpcRequest } from '../rpc'
import type { Services } from '../services'

export async function handleRpc(request: Request, services: Services): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 })
	}
	const resolved = await resolveCaller(request, services)
	if (!resolved.ok) {
		// Use the RPC error envelope so the dashboard's rpc-client can surface the message rather
		// than throwing "undefined" into react-query. A 401 flips the dashboard to the
		// access-required screen (Cloudflare Access owns the operator sign-in).
		return json({ error: { type: 'auth', message: 'forbidden' } }, { status: resolved.status })
	}
	return dispatchRpcRequest<RpcContext>({
		router: appRouter,
		buildContext: () => ({ services, caller: resolved.caller, request }),
		request,
	})
}
