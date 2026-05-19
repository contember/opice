import type { AppRouter } from '@opice/worker'
import { createRpcClient } from './rpc-client'

export const rpc = createRpcClient<AppRouter>({ baseUrl: '/rpc' })
