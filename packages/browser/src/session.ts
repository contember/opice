import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

/**
 * Persistent-browser session for CLI-over-CDP authoring.
 *
 * `launch` spawns a real Chrome (the Playwright-managed binary) with a
 * remote-debugging port, **detached** so it outlives the launching command,
 * and records the CDP endpoint in a session file. Each subsequent verb
 * (`open`, `click`, …) connects over CDP, drives the live page, and
 * disconnects — statefulness lives in the browser process, not in a
 * long-running Node daemon. `connectOverCDP` is why the CLI runs on Node and
 * not Bun (Bun's websocket client can't complete the CDP handshake).
 */

const SESSION_DIR = path.join(tmpdir(), 'opice-browser')

/**
 * Active session name. Multiple named sessions can run side by side, each its
 * own browser — `opice-batch` gives every parallel author its own so they
 * don't share a page. Set via `--session NAME` or `OPICE_BROWSER_SESSION`;
 * defaults to `default`.
 */
let sessionName = process.env['OPICE_BROWSER_SESSION'] ?? 'default'

export function setSessionName(name: string): void {
	sessionName = name
}

function sessionFile(): string {
	return path.join(SESSION_DIR, `${sessionName}.json`)
}

function profileDir(): string {
	return path.join(SESSION_DIR, `profile-${sessionName}`)
}

export interface Session {
	pid: number
	port: number
	wsEndpoint: string
	userDataDir: string
}

export function readSession(): Session {
	const file = sessionFile()
	if (!existsSync(file)) {
		throw new Error(`No browser session "${sessionName}". Run \`opice-browser launch\` first.`)
	}
	return JSON.parse(readFileSync(file, 'utf-8')) as Session
}

function writeSession(session: Session): void {
	mkdirSync(SESSION_DIR, { recursive: true })
	writeFileSync(sessionFile(), JSON.stringify(session), 'utf-8')
}

function clearSession(): void {
	rmSync(sessionFile(), { force: true })
}

/** Is there a live session whose browser process is still running? */
export function sessionAlive(): Session | null {
	if (!existsSync(sessionFile())) return null
	const session = readSession()
	try {
		process.kill(session.pid, 0)
		return session
	} catch {
		clearSession()
		return null
	}
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address()
			const port = typeof addr === 'object' && addr ? addr.port : 0
			srv.close(() => resolve(port))
		})
	})
}

async function waitForEndpoint(port: number, timeoutMs = 15_000): Promise<string> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/version`)
			if (res.ok) {
				const body = (await res.json()) as { webSocketDebuggerUrl?: string }
				if (body.webSocketDebuggerUrl) return body.webSocketDebuggerUrl
			}
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 100))
	}
	throw new Error(`Chrome did not expose a CDP endpoint on port ${port} within ${timeoutMs}ms`)
}

export interface LaunchOptions {
	headed?: boolean
	url?: string
}

/** Launch the persistent browser and record the session. Returns the session. */
export async function launch(opts: LaunchOptions = {}): Promise<Session> {
	const existing = sessionAlive()
	if (existing) return existing

	const port = await freePort()
	const userDataDir = profileDir()
	mkdirSync(userDataDir, { recursive: true })

	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userDataDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		...(opts.headed ? [] : ['--headless=new']),
		opts.url ?? 'about:blank',
	]
	const child = spawn(chromium.executablePath(), args, { detached: true, stdio: 'ignore' })
	child.unref()
	if (child.pid == null) throw new Error('Failed to spawn Chrome')

	const wsEndpoint = await waitForEndpoint(port)
	const session: Session = { pid: child.pid, port, wsEndpoint, userDataDir }
	writeSession(session)
	return session
}

/** Kill the persistent browser and clear the session. */
export function quit(): void {
	const session = sessionAlive()
	if (session) {
		try {
			process.kill(session.pid)
		} catch {
			// already gone
		}
	}
	clearSession()
}

/**
 * Connect to the live browser, hand its current page to `fn`, then disconnect.
 * Disconnecting (`browser.close()` on a CDP connection) does NOT terminate the
 * browser process — the page state persists for the next verb.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
	const session = readSession()
	let browser: Browser | null = null
	try {
		browser = await chromium.connectOverCDP(session.wsEndpoint)
		const context = browser.contexts()[0] ?? (await browser.newContext())
		const page = context.pages()[0] ?? (await context.newPage())
		return await fn(page)
	} finally {
		await browser?.close()
	}
}
