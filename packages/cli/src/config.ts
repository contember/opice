import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface OpiceConfig {
	project: string
	endpoint: string
	/**
	 * Default retry budget applied to every scenario (passed to `bun test
	 * --retry`). A flaky scenario that fails then passes within the budget is
	 * reported as passed-but-flaky. Overridden by `opice test --retries=N` on
	 * the command line, and by a per-scenario `walkthrough`/meta `retries`.
	 */
	retries?: number
	/**
	 * Default test tier to run (`critical` < `standard` < `extended`). Selection
	 * is a threshold — `standard` runs critical + standard. Overridden by `opice
	 * test --tier=NAME` and the `OPICE_TIER` env var. Omitted ⇒ run everything.
	 * Scenarios above the selected tier are reported `skipped`, not run.
	 */
	tier?: 'critical' | 'standard' | 'extended'
}

const CONFIG_NAME = 'opice.config.json'

export async function loadConfig(cwd: string = process.cwd()): Promise<OpiceConfig | null> {
	// Walk up from cwd until we find opice.config.json or hit the root.
	let dir = path.resolve(cwd)
	while (true) {
		const candidate = path.join(dir, CONFIG_NAME)
		try {
			const text = await fs.readFile(candidate, 'utf-8')
			return JSON.parse(text) as OpiceConfig
		} catch {
			// continue up
		}
		const parent = path.dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

export async function writeConfig(cwd: string, config: OpiceConfig): Promise<string> {
	const target = path.join(cwd, CONFIG_NAME)
	await fs.writeFile(target, JSON.stringify(config, null, '\t') + '\n', 'utf-8')
	return target
}
