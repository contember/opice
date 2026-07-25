/**
 * `opice impact [--base REF] [--json] [--model NAME]` — which scenarios does
 * this change reach?
 *
 * Prints the impacted test files (one per line, or `--json` for the full
 * reasoning) so it can be piped straight into `--select`, and reports the state
 * of the platform's footprint index alongside — because "nothing is affected"
 * and "nothing has ever been indexed" produce the same empty list, and only one
 * of them means it's safe to run a smaller suite.
 */

import { loadConfig } from '../config'
import {
	changedPaths,
	defaultBase,
	explainSelection,
	impactedTestFiles,
	queryImpact,
	resolveImpactCredentials,
} from '../impact'

export async function impactCommand(args: string[]): Promise<number> {
	const asJson = args.includes('--json')
	const base = valueOf(args, '--base') ?? defaultBase()
	const models = valuesOf(args, '--model')
	const config = await loadConfig()
	const credentials = resolveImpactCredentials({ ...(config?.project ? { project: config.project } : {}), ...(config?.endpoint ? { endpoint: config.endpoint } : {}) })
	if (!credentials) {
		console.error('[opice] impact needs a platform credential — set OPICE_READ_DSN (preferred) or OPICE_DSN.')
		return 1
	}

	const paths = changedPaths(base)
	if (paths.length === 0 && models.length === 0) {
		if (asJson) console.log(JSON.stringify({ base, paths: [], scenarios: [], testFiles: [] }, null, '\t'))
		else console.error(`[opice] no changes against ${base} — nothing to select.`)
		return 0
	}

	// `--include-loaded` widens to files a scenario merely imported. Off by
	// default: on a real app that dimension saturates (an admin evaluating its
	// schema and component library on import "touches" over a thousand files per
	// scenario), so it would select everything for every change.
	const includeLoaded = args.includes('--include-loaded')
	const result = await queryImpact(credentials, { paths, models, includeLoaded })
	if (!result) return 1

	const testFiles = impactedTestFiles(result.scenarios)
	if (asJson) {
		console.log(JSON.stringify({ base, paths, testFiles, ...result }, null, '\t'))
		return 0
	}

	// The list goes to stdout so it pipes; everything explanatory goes to stderr.
	for (const file of testFiles) console.log(file)
	console.error(`[opice] ${paths.length} changed path(s) against ${base} → ${result.scenarios.length} scenario(s) in ${testFiles.length} file(s).`)
	for (const scenario of result.scenarios) console.error(`[opice]   ${explainSelection(scenario)}`)
	if (result.index.scenarios === 0) {
		console.error(
			'[opice] the footprint index is EMPTY — no run has reported one yet, so this answer means "unknown", not "nothing".\n'
			+ '[opice] Build it with `opice test --footprint` on CI, ON THE DEFAULT BRANCH: only a CI run of\n'
			+ '[opice] main/master writes the index, so a feature branch cannot hand everyone else a view of\n'
			+ '[opice] its half-built state.',
		)
	}
	return 0
}

function valueOf(args: string[], name: string): string | undefined {
	const eq = args.find((a) => a.startsWith(`${name}=`))
	if (eq) return eq.slice(name.length + 1)
	const index = args.indexOf(name)
	const next = index === -1 ? undefined : args[index + 1]
	return next && !next.startsWith('-') ? next : undefined
}

function valuesOf(args: string[], name: string): string[] {
	const out: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith(`${name}=`)) out.push(arg.slice(name.length + 1))
		else if (arg === name) {
			const next = args[i + 1]
			if (next && !next.startsWith('-')) {
				out.push(next)
				i++
			}
		}
	}
	return out.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
}
