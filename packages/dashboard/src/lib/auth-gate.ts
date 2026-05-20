import { useSyncExternalStore } from 'react'

/**
 * Tiny external store tracking whether the worker has demanded authentication
 * (an RPC call came back as an `auth` error). It's flipped from the
 * react-query `QueryCache` callbacks in `main.tsx` — outside React — so it
 * lives here rather than in a context.
 *
 * The distinction the dashboard needs: a *logged-out* visitor with a valid
 * read-token cookie should still see their shared view (queries succeed), so
 * we can't gate on "no session" alone. We gate on "a query actually got 401".
 */
let authRequired = false
const listeners = new Set<() => void>()

export function setAuthRequired(value: boolean): void {
	if (authRequired === value) return
	authRequired = value
	for (const listener of listeners) listener()
}

export function useAuthRequired(): boolean {
	return useSyncExternalStore(
		(cb) => {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
		() => authRequired,
		() => authRequired,
	)
}
