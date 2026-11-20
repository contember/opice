import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { failuresCommand } from './failures'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
let server: ReturnType<typeof Bun.serve> | undefined
let dir: string | undefined

afterEach(() => {
	server?.stop(true)
	server = undefined
	if (dir) rmSync(dir, { recursive: true })
	dir = undefined
})

/** A platform whose link mount answers one failed run, and only to the link's key. */
function platform(): { origin: string; authorizations: (string | null)[] } {
	const authorizations: (string | null)[] = []
	server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			authorizations.push(req.headers.get('authorization'))
			if (req.headers.get('authorization') !== 'Bearer link-key') return new Response('no', { status: 401 })
			const url = new URL(req.url)
			if (url.pathname === '/s/api/run') {
				return Response.json({ result: { id: 'run-1', branch: 'main', commitSha: null, status: 'failed', totalScenarios: 1, failedScenarios: 1 } })
			}
			if (url.pathname === '/s/api/scenarios') {
				return Response.json({ result: { scenarios: [{ id: 'sc-1', name: 'Checkout', hash: null, testFile: 'checkout.test.ts', scenarioFile: null, status: 'failed' }] } })
			}
			if (url.pathname === '/s/api/steps') {
				const input: unknown = await req.json()
				expect(input).toEqual({ scenarioId: 'sc-1' })
				return Response.json({ result: { steps: [{ id: 'st-1', sequence: 2, name: 'pays', status: 'failed', error: 'boom', screenshotUrl: '/s/api/screenshot?stepId=st-1' }] } })
			}
			if (url.pathname === '/s/api/screenshot') return new Response(png, { headers: { 'content-type': 'image/png' } })
			return new Response('missing', { status: 404 })
		},
	})
	return { origin: server.url.origin, authorizations }
}

test('a share link reads its run with the link key and downloads the failed step screenshot', async () => {
	const { origin, authorizations } = platform()
	dir = mkdtempSync(path.join(tmpdir(), 'opice-failures-'))
	const lines: string[] = []
	const log = spyOn(console, 'log').mockImplementation((line: string) => lines.push(line))
	const code = await failuresCommand([`${origin}/s/#link-key`, '--screenshots', dir])
	log.mockRestore()
	expect(code).toBe(0)
	expect(authorizations.every((value) => value === 'Bearer link-key')).toBe(true)
	const file = path.join(dir, '1-step-3.png')
	expect(existsSync(file)).toBe(true)
	expect(new Uint8Array(readFileSync(file))).toEqual(png)
	const digest = lines.join('\n')
	expect(digest).toContain('failed at step 3/1: "pays"')
	expect(digest).toContain(`screenshot: ${file}`)
})
