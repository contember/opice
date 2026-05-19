/**
 * Tiny path-based router. SPA matches the current pathname against patterns
 * and renders the corresponding view. Navigation updates the URL and notifies
 * subscribers; the worker's `not_found_handling: single-page-application`
 * setting makes any path return index.html.
 */

import { useEffect, useState } from 'react'

type Listener = () => void
const listeners = new Set<Listener>()

function notify() {
	for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
	window.addEventListener('popstate', notify)
}

export function navigate(path: string): void {
	window.history.pushState({}, '', path)
	notify()
}

export function usePathname(): string {
	const [path, setPath] = useState(() => window.location.pathname)
	useEffect(() => {
		const listener = () => setPath(window.location.pathname)
		listeners.add(listener)
		return () => {
			listeners.delete(listener)
		}
	}, [])
	return path
}

export interface RouteMatch {
	page: 'home' | 'project' | 'run' | 'notfound'
	params: Record<string, string>
}

export function matchRoute(path: string): RouteMatch {
	if (path === '/' || path === '') return { page: 'home', params: {} }
	const project = path.match(/^\/p\/([^/]+)\/?$/)
	if (project) return { page: 'project', params: { slug: project[1]! } }
	const run = path.match(/^\/p\/([^/]+)\/r\/([^/]+)\/?$/)
	if (run) return { page: 'run', params: { slug: run[1]!, runId: run[2]! } }
	return { page: 'notfound', params: {} }
}
