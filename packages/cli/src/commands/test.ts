import { spawn } from 'node:child_process'
import { loadConfig } from '../config'
import { detectGitMeta } from '../git'

export async function testCommand(args: string[]): Promise<number> {
	const config = await loadConfig()
	const project = process.env['OPICE_PROJECT'] ?? config?.project
	const endpoint = process.env['OPICE_ENDPOINT'] ?? config?.endpoint
	const apiKey = process.env['OPICE_API_KEY']

	if (!project) {
		warn('OPICE_PROJECT not set and no opice.config.json found. Run `opice init` or set the env var.')
	}
	if (!endpoint) {
		warn('OPICE_ENDPOINT not set and no opice.config.json found. Tests will run without reporting.')
	}
	if (!apiKey) {
		warn('OPICE_API_KEY not set. Tests will run without reporting.')
	}

	const git = detectGitMeta()

	const env: NodeJS.ProcessEnv = {
		...process.env,
		...(project ? { OPICE_PROJECT: project } : {}),
		...(endpoint ? { OPICE_ENDPOINT: endpoint } : {}),
		...(git.branch ? { OPICE_BRANCH: git.branch } : {}),
		...(git.commit ? { OPICE_COMMIT: git.commit } : {}),
	}

	const cmd = args.length > 0 ? args : ['test']
	const child = spawn('bun', cmd, { stdio: 'inherit', env })

	return new Promise<number>((resolve) => {
		child.on('exit', (code) => resolve(code ?? 1))
	})
}

function warn(message: string): void {
	console.error(`[opice] warning: ${message}`)
}
