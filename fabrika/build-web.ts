// Placeholder until the dashboard moves here: the deploy needs both SPA directories to exist.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

for (const dir of ['web', 'share']) {
	const out = join(import.meta.dir, 'dist', dir)
	await mkdir(out, { recursive: true })
	await writeFile(join(out, 'index.html'), '<!doctype html><title>Opice</title>\n')
}
