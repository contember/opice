import { hasReadAccess } from '../read-gate'
import { unauthorized } from '../http'
import { appRouter, type RpcContext } from '../router'
import { dispatchRpcRequest } from '../rpc'
import type { Services } from '../services'

export async function handleRpc(request: Request, services: Services): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('method not allowed', { status: 405 })
	}
	if (!hasReadAccess(request, services.config.readToken)) {
		return unauthorized('forbidden')
	}
	return dispatchRpcRequest<RpcContext>({
		router: appRouter,
		buildContext: () => ({ db: services.db }),
		request,
	})
}
