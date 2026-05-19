import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface OpiceConfig {
	project: string
	endpoint: string
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
