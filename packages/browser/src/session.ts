import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Session bookkeeping + the socket client for the persistent authoring server.
 *
 * `opice-browser launch` spawns a long-running server (see server.ts) that
 * holds one browser connection + page; verb commands here are thin clients that
 * RPC a single newline-framed JSON message over the session's unix socket.
 * Holding the connection server-side is what lets transient page state (focus,
 * an open popover) survive between separate verb invocations.
 *
 * Multiple named sessions run side by side (own server, own socket) — set via
 * `--session NAME` or `OPICE_BROWSER_SESSION`; defaults to `default`.
 */

const SESSION_DIR = path.join(tmpdir(), 'opice-browser')

let sessionName = process.env['OPICE_BROWSER_SESSION'] ?? 'default'

export function setSessionName(name: string): void {
	sessionName = name
}

export function sessionFile(): string {
	return path.join(SESSION_DIR, `${sessionName}.json`)
}

export function socketPath(): string {
	return path.join(SESSION_DIR, `${sessionName}.sock`)
}

export function profileDir(): string {
	return path.join(SESSION_DIR, `profile-${sessionName}`)
}

export interface Session {
	serverPid: number
	chromePid: number
	socketPath: string
	port: number
}

function readSession(): Session | null {
	const file = sessionFile()
	if (!existsSync(file)) return null
	try {
		return JSON.parse(readFileSync(file, 'utf-8')) as Session
	} catch {
		return null
	}
}

export function writeSession(session: Session): void {
	mkdirSync(SESSION_DIR, { recursive: true })
	writeFileSync(sessionFile(), JSON.stringify(session), 'utf-8')
}

export interface RpcRequest {
	control?: 'ping' | 'quit'
	name?: string
	flags?: Record<string, unknown>
	positionals?: string[]
}

interface RpcResponse {
	ok: boolean
	result?: unknown
	error?: string
}

/** One request → one response over the session socket (server stays up). */
function rpc(request: RpcRequest, { timeoutMs = 35_000 }: { timeoutMs?: number } = {}): Promise<RpcResponse> {
	return new Promise((resolve, reject) => {
		const sock: Socket = connect(socketPath())
		let buf = ''
		const timer = setTimeout(() => {
			sock.destroy()
			reject(new Error('opice-browser: request timed out'))
		}, timeoutMs)
		sock.on('connect', () => sock.end(JSON.stringify(request)))
		sock.on('data', (d) => { buf += d })
		sock.on('error', (err) => { clearTimeout(timer); reject(err) })
		sock.on('end', () => {
			clearTimeout(timer)
			try {
				resolve(JSON.parse(buf) as RpcResponse)
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	})
}

/** Is a server listening on this session's socket? */
export async function sessionAlive(): Promise<Session | null> {
	if (!existsSync(socketPath())) return null
	try {
		const res = await rpc({ control: 'ping' }, { timeoutMs: 2_000 })
		return res.ok ? readSession() : null
	} catch {
		return null
	}
}

export interface LaunchOptions {
	headed?: boolean
	url?: string
}

/** Start the persistent server (idempotent) and wait until it's serving. */
export async function launch(opts: LaunchOptions = {}): Promise<Session> {
	const existing = await sessionAlive()
	if (existing) return existing

	mkdirSync(SESSION_DIR, { recursive: true })
	rmSync(socketPath(), { force: true })
	rmSync(sessionFile(), { force: true })

	const args = [
		process.argv[1]!,
		'--session', sessionName,
		'__serve',
		...(opts.headed ? ['--headed'] : []),
		...(opts.url ? ['--url', opts.url] : []),
	]
	const server = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
	server.unref()

	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		const session = await sessionAlive()
		if (session) return session
		await new Promise((r) => setTimeout(r, 150))
	}
	throw new Error('opice-browser: server did not come up within 30s')
}

/** Run a verb against the held page (RPC to the server). Returns its result. */
export async function runVerb(name: string, flags: Record<string, unknown>, positionals: string[]): Promise<unknown> {
	const res = await rpc({ name, flags, positionals })
	if (!res.ok) throw new Error(res.error ?? `${name} failed`)
	return res.result
}

/** Stop the server (and its browser). Falls back to killing pids if unreachable. */
export async function quit(): Promise<void> {
	try {
		await rpc({ control: 'quit' })
		return
	} catch {
		// socket gone — best-effort kill from the session file
	}
	const session = readSession()
	for (const pid of [session?.serverPid, session?.chromePid]) {
		if (pid) {
			try {
				process.kill(pid)
			} catch {
				// already gone
			}
		}
	}
	rmSync(socketPath(), { force: true })
	rmSync(sessionFile(), { force: true })
}
