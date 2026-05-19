import type { Project } from './types'

export async function hashApiKey(key: string): Promise<string> {
	const data = new TextEncoder().encode(key)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('')
}

export async function authenticateProject(request: Request, db: D1Database): Promise<Project | null> {
	const header = request.headers.get('authorization')
	if (!header?.startsWith('Bearer ')) {
		return null
	}
	const key = header.slice('Bearer '.length).trim()
	if (!key) {
		return null
	}
	const hash = await hashApiKey(key)
	const row = await db
		.prepare('SELECT * FROM projects WHERE api_key_hash = ?')
		.bind(hash)
		.first<Project>()
	return row ?? null
}

const READ_COOKIE = 'opice_read'

export function hasReadAccess(request: Request, expectedToken: string): boolean {
	if (!expectedToken) {
		return true
	}
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (queryToken === expectedToken) {
		return true
	}
	const cookieHeader = request.headers.get('cookie') ?? ''
	for (const part of cookieHeader.split(';')) {
		const [k, v] = part.trim().split('=')
		if (k === READ_COOKIE && v === expectedToken) {
			return true
		}
	}
	return false
}

export function readAccessRedirect(request: Request, expectedToken: string): Response | null {
	const url = new URL(request.url)
	const queryToken = url.searchParams.get('token')
	if (queryToken && queryToken === expectedToken) {
		const next = new URL(url.toString())
		next.searchParams.delete('token')
		return new Response(null, {
			status: 302,
			headers: {
				'location': next.toString(),
				'set-cookie': `${READ_COOKIE}=${expectedToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
			},
		})
	}
	return null
}
