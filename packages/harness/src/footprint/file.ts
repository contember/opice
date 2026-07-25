/**
 * Local footprint artifacts.
 *
 * Whenever collection is on, the footprint is written to disk — whether or not
 * there's a platform to ship it to. That's what makes the feature usable before
 * any of the reporting stack is involved: `OPICE_FOOTPRINT=full bun test` leaves
 * a readable JSON file per scenario that you can diff, grep or feed to a script.
 *
 * Best-effort throughout: a footprint that can't be written is a warning, never
 * a failure.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { footprintDir } from './config.js'
import { slugify } from '../slug.js'
import type { ScenarioFootprint } from './types.js'

/** Stems already written this process, so two similarly-named scenarios don't collide. */
const usedStems = new Set<string>()

function uniqueStem(stem: string): string {
	let candidate = stem
	for (let n = 2; usedStems.has(candidate); n++) candidate = `${stem}-${n}`
	usedStems.add(candidate)
	return candidate
}

/**
 * Write a scenario's footprint under the footprint directory
 * (`.opice/footprint` by default). Returns the path written, or undefined when
 * it couldn't be.
 */
export async function writeFootprintFile(footprint: ScenarioFootprint, dir = footprintDir()): Promise<string | undefined> {
	const target = path.join(dir, `${uniqueStem(slugify(footprint.scenario, 'scenario'))}.json`)
	try {
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(target, `${JSON.stringify(footprint, null, 2)}\n`)
		return target
	} catch (err) {
		console.warn(`[opice] failed to write footprint for "${footprint.scenario}" (ignored): ${err instanceof Error ? err.message : String(err)}`)
		return undefined
	}
}

/** Test seam — forget which stems have been used. */
export function resetFootprintFiles(): void {
	usedStems.clear()
}
