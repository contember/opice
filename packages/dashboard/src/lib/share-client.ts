import type { ShareRouter } from '@opice/worker'
import { createRpcClient } from './rpc-client'

/**
 * Client for the PUBLIC, read-only share surface (`/s/rpc`), OUTSIDE Cloudflare
 * Access. The anonymous visitor's `?token=` secret is exchanged for the
 * `opice_read` cookie by the Worker before the SPA loads, so this just POSTs
 * with `credentials: 'include'` like the operator client — but never touches
 * `/rpc` or `session.me`, so it can't trip the AuthGate access-required screen.
 */
export const shareRpc = createRpcClient<ShareRouter>({ baseUrl: '/s/rpc' })
