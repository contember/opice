// The import's command line: reads the previous platform's exported database and its screenshot bucket, and sends
// them to this platform's `migration.*` procedures. See README.md beside it.
//
//   bun tools/import/main.ts --source <db.sqlite> --state <state.json> --project <slug>=<id> … [--screenshots-since <date>|all|none]
//     [--concurrency 4] [--retry-uncertain] [--dry-run]

import { S3Client } from 'bun'
import { parseArgs } from 'node:util'
import { dryRun, fileState, ImportStopped, type ImportSummary, machineClient, type ObjectSource, retryingFetch, runImport } from './core'
import { openSource } from './source'

const DAY_MS = 24 * 60 * 60 * 1000

const { values } = parseArgs({
	options: {
		source: { type: 'string' },
		state: { type: 'string' },
		project: { type: 'string', multiple: true },
		'screenshots-since': { type: 'string' },
		concurrency: { type: 'string' },
		'retry-uncertain': { type: 'boolean' },
		'dry-run': { type: 'boolean' },
	},
	strict: true,
})

const fail = (message: string): never => {
	console.error(`[import] ${message}`)
	process.exit(2)
}

const sourcePath = values.source ?? fail('--source <the exported database as a SQLite file> is required')
const statePath = values.state ?? fail('--state <file> is required: the import records its progress there')
const projects = new Map((values.project ?? []).map((pair) => {
	const [slug, id] = pair.split('=')
	return slug && id ? [slug, id] : fail(`--project ${pair}: expected <old slug>=<new project id>`)
}))
const concurrency = Number(values.concurrency ?? '4')
if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency takes a positive integer')

const source = openSource(sourcePath)
const state = fileState(statePath)
// Without the flag a resume keeps the cutoff its state recorded; a first run takes 30 days before now.
const since = values['screenshots-since']
const recorded = state.load().screenshotsSince
const screenshotsSince = since === undefined
	? recorded ?? Date.now() - 30 * DAY_MS
	: since === 'all'
	? 0
	: since === 'none'
	? Number.MAX_SAFE_INTEGER
	: Date.parse(since)
if (Number.isNaN(screenshotsSince)) fail(`--screenshots-since ${since}: expected an ISO date, all or none`)
console.error(`[import] screenshots of runs started at or after ${screenshotsSince === Number.MAX_SAFE_INTEGER ? '(none)' : new Date(screenshotsSince).toISOString()}`)

if (values['dry-run']) {
	console.log(JSON.stringify(dryRun({ source, state, projects, screenshotsSince }), null, 2))
	source.close()
	process.exit(0)
}

const env = (name: string) => process.env[name] ?? fail(`${name} is not set`)
const endpoint = env('OPICE_IMPORT_ENDPOINT')
const key = env('OPICE_IMPORT_KEY')
const bucket = new S3Client({
	endpoint: env('R2_ENDPOINT'),
	bucket: process.env['R2_BUCKET'] ?? 'prod-opice-screenshots',
	accessKeyId: env('R2_ACCESS_KEY_ID'),
	secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
	sessionToken: process.env['R2_SESSION_TOKEN'],
})
const objects: ObjectSource = {
	get: async (objectKey) => {
		try {
			return new Uint8Array(await bucket.file(objectKey).arrayBuffer())
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'NoSuchKey') return null
			throw error
		}
	},
}

const print = (summary: ImportSummary) => console.log(JSON.stringify(summary, null, 2))
try {
	print(
		await runImport({
			source,
			objects,
			client: machineClient({ baseUrl: endpoint, key, fetch: retryingFetch(fetch) }).migration,
			state,
			projects,
			screenshotsSince,
			concurrency,
			retryUncertain: values['retry-uncertain'] === true,
			log: (line) => console.error(`[import] ${line}`),
		}),
	)
} catch (error) {
	if (error instanceof ImportStopped) {
		print(error.summary)
	}
	console.error(`[import] stopped: ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
} finally {
	source.close()
}
