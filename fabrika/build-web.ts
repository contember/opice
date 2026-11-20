// The two SPA builds: the operator dashboard (`web/index.html` → `dist/web`, the `site` mount at `/`) and the share
// view (`web/share/index.html` → `dist/share`, the `shared` link mount at `/s`), each through
// `@fabrika/check/bun-plugin`, which loads the contract without its handlers. The deploy runs it (`pipeline.build`).

import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const root = import.meta.dir

async function build(entry: string, outdir: string, prefix: string): Promise<boolean> {
	await rm(outdir, { recursive: true, force: true })
	const built = await Bun.build({
		entrypoints: [join(root, entry)],
		outdir,
		target: 'browser',
		// React's production build: without it the bundle carries React's development checks.
		define: { 'process.env.NODE_ENV': JSON.stringify('production') },
		minify: true,
		// Each map beside its file, unreferenced: the platform build uploads it and the mount never serves it.
		sourcemap: 'external',
		plugins: [shellSlicePlugin({ root })],
	})
	if (!built.success) {
		for (const log of built.logs) console.error(String(log))
		return false
	}
	// The mount answers `index.html` for every page path under its prefix, so the page loads its assets from the prefix:
	// a deep link such as /p/<project>/r/<run> renders.
	const index = Bun.file(join(outdir, 'index.html'))
	await Bun.write(index, (await index.text()).replaceAll(/(src|href)="\.\//g, `$1="${prefix}`))
	return true
}

const ok = await build(join('web', 'index.html'), join(root, 'dist', 'web'), '/')
	&& await build(join('web', 'share', 'index.html'), join(root, 'dist', 'share'), '/s/')
if (!ok) process.exit(1)
