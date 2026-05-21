#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadUserCommands, runCommand, z, type Command } from '@opice/harness'
import { builtins, positionalHints } from './builtins.js'
import { launch, quit, sessionAlive, setSessionName, withPage } from './session.js'

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

/** Field names for positional mapping: explicit hint, else object-schema keys. */
function positionalNames(name: string, cmd: Command): string[] {
	if (positionalHints[name]) return positionalHints[name]!
	if (cmd.params instanceof z.ZodObject) return Object.keys(cmd.params.shape)
	return []
}

function paramSummary(cmd: Command): string {
	if (cmd.params instanceof z.ZodObject) {
		const keys = Object.keys(cmd.params.shape)
		return keys.length ? keys.map((k) => `<${k}>`).join(' ') : '(no args)'
	}
	return ''
}

async function buildRegistry(): Promise<Map<string, Command>> {
	const registry = new Map<string, Command>()
	for (const cmd of builtins) registry.set(cmd.name, cmd)
	const user = await loadUserCommands()
	for (const [name, cmd] of user) registry.set(name, cmd) // user verbs override built-ins
	return registry
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

		case 'launch': {
			const session = await launch({ headed: !!flags['headed'], url: positionals[0] })
			console.error(`[opice-browser] session up (pid ${session.pid}, port ${session.port})`)
			return 0
		}

		case 'status': {
			const session = sessionAlive()
			console.log(session ? `alive (pid ${session.pid}, port ${session.port})` : 'no session')
			return session ? 0 : 1
		}

		case 'quit':
		case 'close': {
			quit()
			console.error('[opice-browser] session closed')
			return 0
		}

		case 'commands': {
			const registry = await buildRegistry()
			for (const cmd of registry.values()) {
				const builtin = builtins.some((b) => b.name === cmd.name)
				const tag = builtin ? '' : ' (user)'
				console.log(`${cmd.name} ${paramSummary(cmd)}${tag}\n    ${cmd.description ?? ''}`.trimEnd())
			}
			return 0
		}

		default: {
			const registry = await buildRegistry()
			const cmd = registry.get(name)
			if (!cmd) {
				console.error(`Unknown command: ${name}\n`)
				console.error(HELP)
				return 1
			}
			const names = positionalNames(name, cmd)
			const args: Record<string, unknown> = { ...flags }
			positionals.forEach((val, i) => {
				const key = names[i]
				if (key && !(key in args)) args[key] = val
			})
			try {
				const result = await withPage((page) => runCommand(page, cmd, args))
				printResult(result)
				return 0
			} catch (err) {
				console.error(`[opice-browser] ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
				return 1
			}
		}
	}
}

process.exit(await main(process.argv.slice(2)))
