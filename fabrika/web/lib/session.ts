import { useCaller } from '@fabrika/app/react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** Who-am-I for the operator shell; one request shared across the tree. */
export function useMe() {
	return useQuery({
		queryKey: ['session.me'],
		queryFn: () => api.session.me(),
	})
}

/** Whether the signed-in operator may create projects and manage share links (the token's grant, not the check). */
export function useCanWrite(): boolean {
	return useCaller()?.can('project.write') === true
}

/** Sign out of the platform's session. Full navigation: the proxy clears it and returns to the dashboard. */
export function logout(): void {
	window.location.href = '/__fabrika/auth/signout?redirect=/'
}
