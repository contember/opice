import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdirSync, rmSync } from 'node:fs'
import { loadUserSetup, runCommand, type Command } from '@opice/harness'
import { chromium, type Browser, type Page } from 'playwright'
import { buildArgs, buildRegistry } from './builtins.js'
import { profileDir, type Session, sessionFile, socketPath, writeSession } from './session.js'

/**
 * The persistent authoring server. `opice-browser launch` spawns one of these
 * (detached); it spawns Chrome, holds ONE `connectOverCDP` connection + page
 * for its whole lifetime, and serves verbs over a unix socket. Because the
 * connection is held — never torn down between verbs — transient page state
 * (keyboard focus, an open Radix popover, in-flight navigation) survives from
 * one command to the next, exactly like the in-process page in a test. Verb
 * commands (`opice-browser click …`) are thin socket clients (see session.ts).
 */

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

interface ServeOptions {
	headed?: boolean
	url?: string
}

/** Spawn Chrome, hold a page, and serve verbs until told to quit. Never returns. */
export async function runServer(opts: ServeOptions): Promise<void> {
	const port = await freePort()
	const userDataDir = profileDir()
	mkdirSync(userDataDir, { recursive: true })

	// Always boot Chrome on about:blank, never the requested URL: the launch URL
	// is navigated via Playwright below (after browser-setup.ts runs), so its
	// init scripts apply to the first real paint just like in a test.
	const chrome = spawn(chromium.executablePath(), [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userDataDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		// Match the test harness's default viewport. A connectOverCDP page has no
		// Playwright viewport emulation, so without this the headless window is
		// ~800×600 and portalled content (a popover's lower options, a long form)
		// renders off-fold — Playwright then refuses to click "outside of the
		// viewport". Keep authoring and tests seeing the same layout.
		'--window-size=1280,720',
		...(opts.headed ? [] : ['--headless=new']),
		'about:blank',
	], { detached: true, stdio: 'ignore' })
	chrome.unref()
	if (chrome.pid == null) throw new Error('Failed to spawn Chrome')

	const wsEndpoint = await waitForEndpoint(port)
	const browser: Browser = await chromium.connectOverCDP(wsEndpoint)
	const context = browser.contexts()[0] ?? (await browser.newContext())
	const page: Page = context.pages()[0] ?? (await context.newPage())

	// Playwright-launched browsers emulate focus so a headless page reports as
	// focused and `.focus()` sticks; a `connectOverCDP`-attached page does not,
	// so a focus-trap popover (Radix) would blur and close as soon as a verb
	// ends. Enable it on the held CDP session — it persists for the connection's
	// life, so focus survives across separate verb commands.
	try {
		const cdp = await context.newCDPSession(page)
		await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
	} catch {
		// non-fatal: focus-trap popovers may close between verbs without it
	}

	// Repo-level context setup (browser-setup.ts) before the first navigation —
	// the same hook the test harness runs, so the authored page matches the test
	// page (e.g. both suppress dev-only chrome via an addInitScript flag).
	const setup = await loadUserSetup()
	if (setup) await setup(context)
	if (opts.url) await page.goto(opts.url)

	const registry: Map<string, Command> = await buildRegistry()

	const sockPath = socketPath()
	rmSync(sockPath, { force: true })

	let shuttingDown = false
	const shutdown = (): void => {
		if (shuttingDown) return
		shuttingDown = true
		server.close()
		void browser.close().catch(() => {})
		try {
			process.kill(chrome.pid!)
		} catch {
			// already gone
		}
		rmSync(sockPath, { force: true })
		rmSync(sessionFile(), { force: true })
		process.exit(0)
	}

	const handle = async (req: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string; quit?: boolean }> => {
		const control = req['control']
		if (control === 'ping') return { ok: true }
		if (control === 'quit') return { ok: true, quit: true }
		const name = String(req['name'] ?? '')
		const cmd = registry.get(name)
		if (!cmd) return { ok: false, error: `Unknown command: ${name}` }
		const flags = (req['flags'] ?? {}) as Record<string, unknown>
		const positionals = (req['positionals'] ?? []) as string[]
		try {
			const result = await runCommand(page, cmd, buildArgs(name, cmd, flags, positionals))
			return { ok: true, result }
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) }
		}
	}

	// allowHalfOpen: the client half-closes after writing its request; we must
	// still be able to write the response back before ending our side.
	const server = createServer({ allowHalfOpen: true }, (conn: Socket) => {
		let buf = ''
		conn.on('data', (d) => { buf += d })
		conn.on('error', () => {})
		conn.on('end', () => {
			void (async () => {
				let resp: Awaited<ReturnType<typeof handle>>
				try {
					resp = await handle(JSON.parse(buf) as Record<string, unknown>)
				} catch (err) {
					resp = { ok: false, error: err instanceof Error ? err.message : String(err) }
				}
				const quit = resp.quit === true
				conn.end(JSON.stringify({ ok: resp.ok, result: resp.result, error: resp.error }))
				if (quit) conn.on('close', shutdown)
			})()
		})
	})

	// Die with the page: if Chrome or the connection drops, don't linger.
	browser.on('disconnected', shutdown)
	process.on('SIGTERM', shutdown)
	process.on('SIGINT', shutdown)

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(sockPath, () => {
			const session: Session = { serverPid: process.pid, chromePid: chrome.pid!, socketPath: sockPath, port }
			writeSession(session)
			resolve()
		})
	})
	// Keep the event loop alive indefinitely; shutdown() exits the process.
}
