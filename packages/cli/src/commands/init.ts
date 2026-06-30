import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadConfig, writeConfig } from '../config'

interface InitOptions {
	project?: string
	endpoint?: string
	withWorkflow?: boolean
}

export async function initCommand(opts: InitOptions): Promise<number> {
	const cwd = process.cwd()
	const existing = await loadConfig(cwd)
	if (existing) {
		console.error(`opice.config.json already exists in this project (project=${existing.project}).`)
		console.error('Edit it directly, or delete it and re-run init.')
		return 1
	}

	const project = opts.project ?? prompt('Project slug:') ?? ''
	if (!project) {
		console.error('Project slug is required.')
		return 1
	}
	const endpoint = opts.endpoint ?? prompt('Reporter endpoint (e.g. https://opice.example.com):') ?? ''
	if (!endpoint) {
		console.error('Endpoint is required.')
		return 1
	}

	const configPath = await writeConfig(cwd, { project, endpoint })
	console.log(`✓ Wrote ${path.relative(cwd, configPath)}`)

	if (opts.withWorkflow) {
		const workflowPath = await writeWorkflow(cwd)
		console.log(`✓ Wrote ${path.relative(cwd, workflowPath)}`)
	}

	console.log()
	console.log('Next steps:')
	console.log('  1. Set OPICE_DSN (from the dashboard) in .env locally and as a CI repo secret.')
	console.log('  2. Run your tests via `opice test <bun-test-args>` to stream results.')
	return 0
}

async function writeWorkflow(cwd: string): Promise<string> {
	const target = path.join(cwd, '.github', 'workflows', 'opice.yml')
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, WORKFLOW_TEMPLATE, 'utf-8')
	return target
}

const WORKFLOW_TEMPLATE = `name: opice browser tests

# Tiered runs: a push runs only the critical core (fast gate), a PR runs the
# standard suite, and the nightly schedule (or a manual dispatch) runs
# everything. Scenarios above the selected tier are reported "skipped" on the
# dashboard, not silently dropped. Tune the triggers + tiers to taste.
#
# To keep PRs fast yet exercise what they touch, run the critical core PLUS the
# changed scenarios instead of the whole standard suite: pass the changed test
# files via --select (deduplicated against the tier, never run twice), e.g.
#   --tier critical --select "\$(git diff --name-only origin/main...HEAD \\
#     -- 'tests/browser/*.test.ts' | paste -sd,)"
# (needs actions/checkout fetch-depth: 0 so the base ref is available).
on:
  push:
  pull_request:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Install Playwright Chromium
        run: bunx playwright install --with-deps chromium
      - name: Start playground (background)
        run: bun run dev &
        env:
          NODE_ENV: development
      - name: Wait for playground
        run: |
          for i in $(seq 1 30); do
            if curl -sf http://localhost:5173 > /dev/null; then break; fi
            sleep 1
          done
      - name: Run opice browser tests
        run: bunx opice test tests/browser/ --tier "\${{ (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && 'extended' || github.event_name == 'pull_request' && 'standard' || 'critical' }}"
        env:
          OPICE_DSN: \${{ secrets.OPICE_DSN }}
          PLAYGROUND_URL: http://localhost:5173
`
