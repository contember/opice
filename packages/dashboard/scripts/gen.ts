#!/usr/bin/env bun
/**
 * Run Buzola's codegen via Bun so the page-metadata extractor can
 * actually `import()` our .tsx route files. The shipped `bunx buzola`
 * CLI uses Node and fails to load TSX.
 */
import { generate } from '@buzola/vite-plugin'
import path from 'node:path'

const root = path.resolve(import.meta.dir, '..')
await generate({
	routesDir: path.join(root, 'src/routes'),
	outputPath: path.join(root, 'src/buzola.gen.ts'),
})
