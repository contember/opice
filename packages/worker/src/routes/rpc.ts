import { json } from '../http'
import { resolveOperator } from '../principal'
import { appRouter, type RpcContext } from '../router'
import { dispatchRpcRequest } from '../rpc'
import type { Services } from '../services'

/**
 * The OPERATOR RPC endpoint (`/rpc`) — behind Cloudflare Access. The forwarded Access JWT
 * resolves through propustka to an operator `AuthContext`; a 401 flips the dashboard to the
 * access-required screen (Access owns operator sign-in).
 */
export async function handleRpc(request: Request, services: Services): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 })
	}
	const auth = await resolveOperator(request, services)
	if (!auth.ok) {
		return json({ error: { type: 'auth', message: 'forbidden' } }, { status: auth.status })
	}
	return dispatchRpcRequest<RpcContext>({
		router: appRouter,
		buildContext: () => ({ services, auth, request }),
		request,
	})
}
