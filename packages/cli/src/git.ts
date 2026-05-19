import { execSync } from 'node:child_process'

/**
 * Best-effort git metadata for the current working tree. Returns the values
 * configured in opice runs (branch, commit). Falls back to env vars commonly
 * set by CI (GITHUB_REF_NAME, GITHUB_SHA) when not in a git checkout.
 */
export function detectGitMeta(): { branch?: string; commit?: string } {
	const fromEnv = {
		branch: process.env['OPICE_BRANCH'] ?? process.env['GITHUB_REF_NAME'],
		commit: process.env['OPICE_COMMIT'] ?? process.env['GITHUB_SHA'],
	}
	if (fromEnv.branch && fromEnv.commit) return fromEnv

	try {
		const branch = run('git rev-parse --abbrev-ref HEAD')
		const commit = run('git rev-parse HEAD')
		return {
			branch: fromEnv.branch ?? branch,
			commit: fromEnv.commit ?? commit,
		}
	} catch {
		return fromEnv
	}
}

function run(cmd: string): string {
	return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}
