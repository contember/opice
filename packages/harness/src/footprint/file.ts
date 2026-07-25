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
import { slugify, uniqueStem } from '../slug.js'
import type { ScenarioFootprint } from './types.js'

/** Stems already written this process, so two similarly-named scenarios don't collide. */
const usedStems = new Set<string>()

/**
 * Serialize a scenario's footprint and write it under the footprint directory
 * (`.opice/footprint` by default).
 *
 * Returns the JSON, which the caller also uploads — at the collector's caps a
 * footprint runs to megabytes, so it is serialized once here rather than again
 * in the reporter. A failed write still returns the JSON: the upload doesn't
 * depend on the file.
 */
export async function writeFootprintFile(footprint: ScenarioFootprint, dir = footprintDir()): Promise<string> {
	const json = JSON.stringify(footprint, null, 2)
	const target = path.join(dir, `${uniqueStem(slugify(footprint.scenario, 'scenario'), usedStems)}.json`)
	try {
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(target, `${json}\n`)
	} catch (err) {
		console.warn(`[opice] failed to write footprint for "${footprint.scenario}" (ignored): ${err instanceof Error ? err.message : String(err)}`)
	}
	return json
}
