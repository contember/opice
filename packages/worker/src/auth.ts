import type { Db } from './db'
import type { Project } from './types'

export async function hashApiKey(key: string): Promise<string> {
	const data = new TextEncoder().encode(key)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('')
}

export function generateApiKey(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Read tokens are random like API keys but stored plaintext (read-only). */
export const generateReadToken = generateApiKey

export async function authenticateProject(request: Request, db: Db): Promise<Project | null> {
	const header = request.headers.get('authorization')
	if (!header?.startsWith('Bearer ')) {
		return null
	}
	const key = header.slice('Bearer '.length).trim()
	if (!key) {
		return null
	}
	const hash = await hashApiKey(key)
	return db.getProjectByApiKeyHash(hash)
}

export function authenticateAdmin(request: Request, expectedToken: string | undefined): boolean {
	if (!expectedToken) return false
	return request.headers.get('x-admin-token') === expectedToken
}
