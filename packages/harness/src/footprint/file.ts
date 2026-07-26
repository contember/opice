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

/**
 * Stems already written THIS process. `bun test` runs one process per test file,
 * so this set alone cannot see a collision across files — which is why the stem
 * below leads with the test file's own name. The set still handles two scenarios
 * that collide within one file.
 */
const usedStems = new Set<string>()

/**
 * Filename stem for a footprint: the test file's name, then the scenario's.
 *
 * Two files may legitimately hold a scenario of the same name, and since each
 * runs in its own process there is no shared set to disambiguate them — without
 * the file in the name the second silently overwrites the first's artifact.
 */
function footprintStem(footprint: ScenarioFootprint): string {
	const scenario = slugify(footprint.scenario, 'scenario')
	if (!footprint.testFile) return scenario
	// The FULL relative path, not just the basename: `a/index.test.ts` and
	// `b/index.test.ts` are a normal shape, they run in separate processes, and on
	// basename alone they would race for the same artifact.
	const withoutSuffix = footprint.testFile.replace(/\.(test|spec)\.[tj]sx?$/i, '')
	const file = slugify(withoutSuffix, '')
	return file ? `${file}--${scenario}` : scenario
}

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
	const target = path.join(dir, `${uniqueStem(footprintStem(footprint), usedStems)}.json`)
	try {
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(target, `${json}\n`)
	} catch (err) {
		console.warn(`[opice] failed to write footprint for "${footprint.scenario}" (ignored): ${err instanceof Error ? err.message : String(err)}`)
	}
	return json
}
