import { defineApp } from '@fabrika/provider-cloudflare'

// The deployer builds the proxy Worker from `fabrika.contract.ts`, writes the object, the files bucket, the tick and
// the framework variables, and stages the SPA builds (`dist/web`, `dist/share`) as `ASSETS`.
export default defineApp({ id: 'opice', pipeline: { build: 'bun run build:web' } })
