#!/usr/bin/env bun
/**
 * Run Buzola's codegen via Bun so the page-metadata extractor can
 * actually `import()` our .tsx route files. The shipped `bunx buzola`
 * CLI uses Node and fails to load TSX.
 *
 * `generate` lives in `@buzola/codegen`, which isn't a direct dependency
 * here — it's pulled in transitively by `@buzola/vite-plugin`. Resolve it
 * relative to the plugin so this works regardless of how the store hoists
 * (no extra dependency to install).
 */
import path from 'node:path'

const codegenUrl = import.meta.resolve('@buzola/codegen', import.meta.resolve('@buzola/vite-plugin'))
const { generate } = await import(codegenUrl)

const root = path.resolve(import.meta.dir, '..')
await generate({
	routesDir: path.join(root, 'src/routes'),
	outputPath: path.join(root, 'src/buzola.gen.ts'),
})
