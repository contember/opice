import { execSync } from 'node:child_process'

const EXEC_TIMEOUT = 30_000

let currentSession: string | null = null

export function setSession(session: string | null): void {
	currentSession = session
}

export function getSession(): string | null {
	return currentSession
}

export function exec(cmd: string): string {
	const sessionFlag = currentSession ? `--session ${currentSession} ` : ''
	const fullCmd = cmd.replace(/^agent-browser /, `agent-browser ${sessionFlag}`)
	try {
		const raw = execSync(fullCmd, { encoding: 'utf-8', timeout: EXEC_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
		return raw.replace(/\x1B\[[0-9;]*m/g, '')
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; message?: string }
		const output = err.stdout?.trim() ?? err.stderr?.trim() ?? err.message ?? 'unknown error'
		throw new Error(`agent-browser command failed: ${fullCmd}\n${output}`)
	}
}

export function q(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`
}
