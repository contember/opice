import { useQuery } from '@tanstack/react-query'
import { rpc } from './client'

/**
 * Who-am-I for the dashboard shell. The query key is stable so callers across
 * the tree share one network request. Returns the session shape the worker
 * defines: `authenticated` + `email` for operators, all-false for a share-link
 * visitor. Throws `RpcError` with `type: 'auth'` on HTTP 401 (no valid
 * credential at all) — the `QueryCache` callback in `main.tsx` flips the
 * AuthGate to the "access required" screen.
 */
export function useMe() {
	return useQuery({
		queryKey: ['session.me'],
		queryFn: () => rpc.session.me(),
	})
}

/** Sign out of Cloudflare Access. Full navigation — no app session to clear. */
export function logout(): void {
	window.location.href = '/cdn-cgi/access/logout'
}
