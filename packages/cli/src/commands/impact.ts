/**
 * `opice impact [--base REF] [--model NAME] [--include-loaded] [--json]` — which
 * scenarios does this change reach?
 *
 * Prints the impacted test files to stdout, one per line, so it pipes straight
 * into `--select`; the reasoning — including whether the index has ever been
 * built, since "nothing is affected" and "nothing was ever indexed" produce the
 * same empty list — goes to stderr. `opice test --impacted` runs the same query
 * through {@link resolveImpact} and skips the printing.
 */

import { extractBoolean, extractList, extractValue } from '../args'
import { loadConfig } from '../config'
import { resolveImpact } from '../impact'

export async function impactCommand(args: string[]): Promise<number> {
	const { present: asJson, rest: afterJson } = extractBoolean(args, 'json')
	// `--include-loaded` widens to files a scenario merely imported. Off by
	// default: that dimension saturates on a real app (an admin evaluating its
	// schema and component library on import "touches" over a thousand files per
	// scenario), so it would select everything for every change.
	const { present: includeLoaded, rest: afterLoaded } = extractBoolean(afterJson, 'include-loaded')
	const { value: base, rest: afterBase } = extractValue(afterLoaded, 'base')
	const { values: models } = extractList(afterBase, 'model')

	const config = await loadConfig()
	const resolved = await resolveImpact(
		{ ...(config?.project ? { project: config.project } : {}), ...(config?.endpoint ? { endpoint: config.endpoint } : {}) },
		{ ...(base ? { base } : {}), models, includeLoaded },
	)
	// Null means the query could not be ANSWERED — no credentials, an unreachable
	// platform, an index that was never built. `resolved.empty` means it was
	// answered and the answer is "nothing changed", which is a success with no
	// output.
	if (!resolved) return 1
	if (resolved.empty && !asJson) return 0

	if (asJson) {
		// `empty` is carried through so a consumer can tell "nothing changed" from
		// "nothing was ever indexed" — the `index` counts below are placeholders
		// when no query was made.
		console.log(JSON.stringify({
			base: resolved.base,
			paths: resolved.paths,
			testFiles: resolved.files,
			...(resolved.empty ? { empty: true } : {}),
			...resolved.result,
		}, null, '\t'))
	} else {
		for (const file of resolved.files) console.log(file)
	}
	return 0
}
