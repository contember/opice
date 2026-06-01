/**
 * `opice tokens <create|list|revoke>` — manage API tokens from the terminal.
 *
 * Like `opice users create`, these are operator actions: they call the
 * `admin.*` RPCs with the bootstrap admin token as a Bearer credential
 * (--admin-token or OPICE_ADMIN_TOKEN) against the platform endpoint
 * (--endpoint, OPICE_ENDPOINT, or opice.config.json).
 *
 * `create` is the headless counterpart to the dashboard's "new project" read
 * key: mint a project-scoped read token and it prints a ready-to-paste
 * `OPICE_READ_DSN` an authoring agent can drop into `.env` to read results.
 */

import { loadConfig } from '../config'
import { parseOpiceDsn } from '../dsn'

interface CommonFlags {
	endpoint?: string
	adminToken?: string
}

interface CreateFlags extends CommonFlags {
	project?: string
	capability: 'read' | 'write'
	label?: string
	expiresInDays?: number
}

interface TokenSummary {
	id: string
	capability: 'read' | 'write' | 'admin'
	projectSlug: string | null
	runId: string | null
	label: string | null
	createdAt: number
	expiresAt: number | null
	lastUsedAt: number | null
}

const USAGE = `Usage:
  opice tokens create [--project=SLUG] [--capability=read|write] [--label=...] [--expires-days=N] [--endpoint=URL] [--admin-token=TOKEN]
  opice tokens list [--project=SLUG] [--endpoint=URL] [--admin-token=TOKEN]
  opice tokens revoke <token-id> [--endpoint=URL] [--admin-token=TOKEN]`

export async function tokensCommand(args: string[]): Promise<number> {
	const [sub, ...rest] = args
	switch (sub) {
		case 'create':
			return createToken(rest)
		case 'list':
			return listTokens(rest)
		case 'revoke':
			return revokeToken(rest)
		default:
			console.error(USAGE)
			return 1
	}
}

async function createToken(args: string[]): Promise<number> {
	const flags = parseCreateFlags(args)
	const target = await resolveTarget(flags)
	if (!target) return 1

	if (!flags.project && flags.capability !== 'read') {
		console.error('A global (project-less) token must be read-only. Pass --project=SLUG for a write token.')
		return 1
	}

	const result = await rpc<{ id: string; token: string; expiresAt: number | null }>(target, 'admin.createToken', {
		...(flags.project ? { projectSlug: flags.project } : {}),
		capability: flags.capability,
		...(flags.label ? { label: flags.label } : {}),
		...(flags.expiresInDays != null ? { expiresInDays: flags.expiresInDays } : {}),
	})
	if (!result) return 1

	console.log(`✓ Created ${flags.capability} token ${result.id}`)
	console.log(`  token: ${result.token}`)
	if (result.expiresAt != null) console.log(`  expires: ${new Date(result.expiresAt).toISOString()}`)
	if (flags.project) {
		const host = new URL(target.endpoint).host
		const envVar = flags.capability === 'read' ? 'OPICE_READ_DSN' : 'OPICE_DSN'
		console.log('')
		console.log(`  ${envVar}=https://${result.token}@${host}/${flags.project}`)
	}
	console.log('  (shown once — store it now; only its hash is kept)')
	return 0
}

async function listTokens(args: string[]): Promise<number> {
	const flags = parseCommonFlags(args)
	const project = flags['project']
	const target = await resolveTarget(flags)
	if (!target) return 1

	const tokens = await rpc<TokenSummary[]>(target, 'admin.listTokens', project ? { projectSlug: project } : {})
	if (!tokens) return 1

	if (tokens.length === 0) {
		console.log('No tokens.')
		return 0
	}
	for (const t of tokens) {
		const scope = t.runId ? `run ${t.runId}` : (t.projectSlug ?? 'all projects')
		const meta = [
			t.label ?? '(no label)',
			t.capability,
			scope,
			t.expiresAt ? `expires ${new Date(t.expiresAt).toISOString().slice(0, 10)}` : 'no expiry',
			t.lastUsedAt ? `used ${new Date(t.lastUsedAt).toISOString().slice(0, 10)}` : 'never used',
		].join(' · ')
		console.log(`${t.id}  ${meta}`)
	}
	return 0
}

async function revokeToken(args: string[]): Promise<number> {
	const positional = args.filter((a) => !a.startsWith('--'))
	const tokenId = positional[0]
	if (!tokenId) {
		console.error('Usage: opice tokens revoke <token-id> [--endpoint=URL] [--admin-token=TOKEN]')
		return 1
	}
	const flags = parseCommonFlags(args)
	const target = await resolveTarget(flags)
	if (!target) return 1

	const result = await rpc<{ revoked: boolean }>(target, 'admin.revokeToken', { tokenId })
	if (!result) return 1
	console.log(result.revoked ? `✓ Revoked ${tokenId}` : `Token not found or already revoked: ${tokenId}`)
	return 0
}

interface Target {
	endpoint: string
	adminToken: string
}

async function resolveTarget(flags: CommonFlags | Record<string, string | undefined>): Promise<Target | null> {
	const endpoint =
		flags['endpoint'] ?? process.env['OPICE_ENDPOINT'] ?? (await loadConfig())?.endpoint ?? parseOpiceDsn(process.env['OPICE_DSN'])?.endpoint
	if (!endpoint) {
		console.error('Could not determine the platform endpoint. Pass --endpoint=URL, set OPICE_ENDPOINT, or run from a project with opice.config.json.')
		return null
	}
	const adminToken = flags['adminToken'] ?? process.env['OPICE_ADMIN_TOKEN']
	if (!adminToken) {
		console.error('Missing admin token. Pass --admin-token=TOKEN or set OPICE_ADMIN_TOKEN.')
		return null
	}
	return { endpoint: endpoint.replace(/\/$/, ''), adminToken }
}

async function rpc<T>(target: Target, method: string, input: unknown): Promise<T | null> {
	let response: Response
	try {
		response = await fetch(`${target.endpoint}/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${target.adminToken}` },
			body: JSON.stringify({ method, input }),
		})
	} catch (err) {
		console.error(`[opice] request failed: ${(err as Error).message}`)
		return null
	}
	const data = (await response.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null
	if (!response.ok || !data || data.error || data.result === undefined) {
		const message = data?.error?.message ?? `${response.status} ${response.statusText}`
		console.error(`[opice] ${method} failed: ${message}`)
		return null
	}
	return data.result as T
}

function parseCreateFlags(args: string[]): CreateFlags {
	const flags: CreateFlags = { capability: 'read' }
	for (const arg of args) {
		if (arg.startsWith('--project=')) flags.project = arg.slice('--project='.length)
		else if (arg.startsWith('--capability=')) {
			const v = arg.slice('--capability='.length)
			if (v === 'read' || v === 'write') flags.capability = v
		} else if (arg.startsWith('--label=')) flags.label = arg.slice('--label='.length)
		else if (arg.startsWith('--expires-days=')) {
			const n = Number(arg.slice('--expires-days='.length))
			if (Number.isFinite(n)) flags.expiresInDays = n
		} else if (arg.startsWith('--endpoint=')) flags.endpoint = arg.slice('--endpoint='.length)
		else if (arg.startsWith('--admin-token=')) flags.adminToken = arg.slice('--admin-token='.length)
	}
	return flags
}

function parseCommonFlags(args: string[]): Record<string, string | undefined> {
	const flags: Record<string, string | undefined> = {}
	for (const arg of args) {
		if (arg.startsWith('--project=')) flags['project'] = arg.slice('--project='.length)
		else if (arg.startsWith('--endpoint=')) flags['endpoint'] = arg.slice('--endpoint='.length)
		else if (arg.startsWith('--admin-token=')) flags['adminToken'] = arg.slice('--admin-token='.length)
	}
	return flags
}
