import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** The project a route names, by its slug or its id (the CLI links runs by id). */
export function useProject(ref: string) {
	return useQuery({
		queryKey: ['projects.get', ref],
		queryFn: async () => (await api.projects.get({ slug: ref })).project,
	})
}
