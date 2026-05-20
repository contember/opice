import { resolveReadScope } from '../read-gate'
import { json } from '../http'
import { appRouter, type RpcContext } from '../router'
import { dispatchRpcRequest } from '../rpc'
import type { Services } from '../services'

export async function handleRpc(request: Request, services: Services): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 })
	}
	const scope = await resolveReadScope(request, services)
	if (!scope) {
		// Use the RPC error envelope so the dashboard's rpc-client can surface
		// the message rather than throwing "undefined" into react-query.
		return json({ error: { type: 'auth', message: 'forbidden' } }, { status: 401 })
	}
	return dispatchRpcRequest<RpcContext>({
		router: appRouter,
		buildContext: () => ({ db: services.db, scope }),
		request,
	})
}
