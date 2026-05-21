#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildRegistry, isBuiltin, paramSummary } from './builtins.js'
import { launch, quit, runVerb, sessionAlive, setSessionName } from './session.js'

// opice-browser must run under Node: Playwright's `connectOverCDP` websocket
// can't complete its handshake under Bun. However it gets launched (bunx, a
// bun-created bin shim, `bun run`), re-exec under Node so the verb always works.
function reexecUnderNodeIfBun(): void {
	if (!process.versions['bun']) return
	const result = spawnSync('node', [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' })
	if (result.error) {
		console.error('[opice-browser] requires Node on PATH (Playwright CDP does not work under Bun):', result.error.message)
		process.exit(127)
	}
	process.exit(result.status ?? 1)
}

const HELP = `opice-browser — stateful Playwright browser for opice authoring

Usage: opice-browser [--session NAME] <command> [positionals] [--flag value]

A launched session holds one browser connection + page for its whole life, so
focus and open popovers survive between commands (verbs are socket clients).

Sessions: each named session is its own browser (default: "default", or
$OPICE_BROWSER_SESSION). opice-batch gives each parallel author its own.

Lifecycle:
  launch [url] [--headed]   Start the persistent browser (idempotent).
  status                    Show whether a session is alive.
  quit                      Close the browser and clear the session.

Inspect:
  commands                  List all verbs (built-in + browser-tools.ts).
  aria-snapshot [selector]  Print the ARIA tree (the agent's view).

Verbs (examples):
  open <url>
  click <selector>                 fill <selector> <value>
  byRole <role> [action] --name X  byLabel <label> [action]
  text <selector>                  press <key> [--selector s]

Selectors: a bare word is a data-testid; anything with CSS chars is raw CSS.
Verbs from <repo>/browser-tools.ts are available too (flag or positional args).
`

interface ParsedArgs {
	flags: Record<string, string | boolean>
	positionals: string[]
}

function parseArgs(tokens: string[]): ParsedArgs {
	const flags: Record<string, string | boolean> = {}
	const positionals: string[] = []
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!
		if (token.startsWith('--')) {
			const eq = token.indexOf('=')
			if (eq >= 0) {
				flags[token.slice(2, eq)] = token.slice(eq + 1)
			} else {
				const key = token.slice(2)
				const next = tokens[i + 1]
				if (next !== undefined && !next.startsWith('--')) {
					flags[key] = next
					i++
				} else {
					flags[key] = true
				}
			}
		} else {
			positionals.push(token)
		}
	}
	return { flags, positionals }
}

/** Consume a leading `--session NAME` / `--session=NAME` (else env / default). */
function takeSession(argv: string[]): string[] {
	const first = argv[0]
	if (first === '--session' && argv[1] !== undefined) {
		setSessionName(argv[1])
		return argv.slice(2)
	}
	if (first?.startsWith('--session=')) {
		setSessionName(first.slice('--session='.length))
		return argv.slice(1)
	}
	return argv
}

function printResult(result: unknown): void {
	if (result === undefined || result === null) {
		console.log('ok')
	} else if (typeof result === 'string') {
		console.log(result)
	} else {
		console.log(JSON.stringify(result))
	}
}

async function main(rawArgv: string[]): Promise<number> {
	reexecUnderNodeIfBun()
	const [name, ...rest] = takeSession(rawArgv)
	const { flags, positionals } = parseArgs(rest)

	switch (name) {
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			console.log(HELP)
			return 0

		case '__serve': {
			// Internal: the long-running server process spawned by `launch`.
			const { runServer } = await import('./server.js')
			await runServer({ headed: !!flags['headed'], url: typeof flags['url'] === 'string' ? flags['url'] : undefined })
			// Block forever — the server's shutdown() calls process.exit on quit.
			// Returning here would let the top-level process.exit kill the server.
			await new Promise<never>(() => {})
			return 0
		}

		case 'launch': {
			const session = await launch({ headed: !!flags['headed'], url: positionals[0] })
			console.error(`[opice-browser] session up (pid ${session.serverPid}, port ${session.port})`)
			return 0
		}

		case 'status': {
			const session = await sessionAlive()
			console.log(session ? `alive (pid ${session.serverPid}, port ${session.port})` : 'no session')
			return session ? 0 : 1
		}

		case 'quit':
		case 'close': {
			await quit()
			console.error('[opice-browser] session closed')
			return 0
		}

		case 'commands': {
			// Listed locally — no running server needed.
			const registry = await buildRegistry()
			for (const cmd of registry.values()) {
				const tag = isBuiltin(cmd.name) ? '' : ' (user)'
				console.log(`${cmd.name} ${paramSummary(cmd)}${tag}\n    ${cmd.description ?? ''}`.trimEnd())
			}
			return 0
		}

		default: {
			try {
				printResult(await runVerb(name, flags, positionals))
				return 0
			} catch (err) {
				console.error(`[opice-browser] ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
				return 1
			}
		}
	}
}

process.exit(await main(process.argv.slice(2)))
