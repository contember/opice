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

on:
  push:
    branches: [main]
  pull_request:

jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Install agent-browser
        run: bun add -g agent-browser
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
        run: bunx opice test tests/browser/
        env:
          OPICE_DSN: \${{ secrets.OPICE_DSN }}
          PLAYGROUND_URL: http://localhost:5173
`
