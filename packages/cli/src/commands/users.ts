/**
 * `opice users create <email>` — create a dashboard login.
 *
 * Self-service signup is disabled on the platform; this is the sanctioned way
 * to mint an account. It calls the admin endpoint, so it needs the admin token
 * (--admin-token or OPICE_ADMIN_TOKEN) and the platform endpoint (--endpoint,
 * OPICE_ENDPOINT, or opice.config.json). Every account is a full admin.
 *
 * If no password is given one is generated and printed once.
 */

import { loadConfig } from '../config'

interface CreateUserFlags {
	email?: string
	password?: string
	name?: string
	endpoint?: string
	adminToken?: string
}

export async function usersCommand(args: string[]): Promise<number> {
	const [sub, ...rest] = args
	if (sub !== 'create') {
		console.error('Usage: opice users create <email> [--password=...] [--name=...] [--endpoint=URL] [--admin-token=TOKEN]')
		return 1
	}

	const flags = parseFlags(rest)
	if (!flags.email) {
		console.error('Usage: opice users create <email> [--password=...] [--name=...] [--endpoint=URL] [--admin-token=TOKEN]')
		return 1
	}

	const endpoint = flags.endpoint ?? process.env['OPICE_ENDPOINT'] ?? (await loadConfig())?.endpoint
	if (!endpoint) {
		console.error('Could not determine the platform endpoint. Pass --endpoint=URL, set OPICE_ENDPOINT, or run from a project with opice.config.json.')
		return 1
	}

	const adminToken = flags.adminToken ?? process.env['OPICE_ADMIN_TOKEN']
	if (!adminToken) {
		console.error('Missing admin token. Pass --admin-token=TOKEN or set OPICE_ADMIN_TOKEN.')
		return 1
	}

	const generated = !flags.password
	const password = flags.password ?? generatePassword()

	let response: Response
	try {
		response = await fetch(`${endpoint.replace(/\/$/, '')}/api/v1/admin/users`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-admin-token': adminToken },
			body: JSON.stringify({ email: flags.email, password, ...(flags.name ? { name: flags.name } : {}) }),
		})
	} catch (err) {
		console.error(`[opice] request failed: ${(err as Error).message}`)
		return 1
	}

	const data = (await response.json().catch(() => null)) as { email?: string; error?: { message?: string } } | null
	if (!response.ok || !data || data.error) {
		const message = data?.error?.message ?? `${response.status} ${response.statusText}`
		console.error(`[opice] could not create user: ${message}`)
		return 1
	}

	console.log(`✓ Created user ${data.email ?? flags.email}`)
	if (generated) {
		console.log(`  password: ${password}`)
		console.log('  (shown once — store it in your password manager now)')
	}
	return 0
}

function parseFlags(args: string[]): CreateUserFlags {
	const flags: CreateUserFlags = {}
	for (const arg of args) {
		if (arg.startsWith('--password=')) flags.password = arg.slice('--password='.length)
		else if (arg.startsWith('--name=')) flags.name = arg.slice('--name='.length)
		else if (arg.startsWith('--endpoint=')) flags.endpoint = arg.slice('--endpoint='.length)
		else if (arg.startsWith('--admin-token=')) flags.adminToken = arg.slice('--admin-token='.length)
		else if (!arg.startsWith('--') && !flags.email) flags.email = arg
	}
	return flags
}

/** A 20-char base64url password — comfortably over the 10-char server minimum. */
function generatePassword(): string {
	const bytes = new Uint8Array(15)
	crypto.getRandomValues(bytes)
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
