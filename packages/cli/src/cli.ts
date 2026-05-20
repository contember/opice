#!/usr/bin/env bun
import { failuresCommand } from './commands/failures'
import { initCommand } from './commands/init'
import { testCommand } from './commands/test'

const HELP = `opice — AI-driven E2E browser test harness

Usage: opice <command> [options]

Commands:
  init [--project=SLUG] [--endpoint=URL] [--with-workflow]
      Scaffold opice.config.json in the current project. Pass
      --with-workflow to also drop a .github/workflows/opice.yml.

  test [bun test args...]
      Wrapper around 'bun test' that exports OPICE_* env vars from
      opice.config.json + git so the harness reporter streams results
      to the platform. All trailing args pass through to bun test.

  failures <run-url|run-id> [--json]
      Pull a failed run's details (failed scenarios, the failing step,
      error, screenshot URL, and source files) for the re-eval workflow.
      Token comes from the URL's ?token= or OPICE_READ_TOKEN.

  help
      Show this message.
`

async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv
	switch (command) {
		case 'init':
			return initCommand(parseInitFlags(rest))
		case 'test':
			return testCommand(rest)
		case 'failures':
			return failuresCommand(rest)
		case 'help':
		case '--help':
		case '-h':
		case undefined:
			console.log(HELP)
			return 0
		default:
			console.error(`Unknown command: ${command}`)
			console.error(HELP)
			return 1
	}
}

function parseInitFlags(args: string[]): { project?: string; endpoint?: string; withWorkflow?: boolean } {
	const flags: { project?: string; endpoint?: string; withWorkflow?: boolean } = {}
	for (const arg of args) {
		if (arg === '--with-workflow') flags.withWorkflow = true
		else if (arg.startsWith('--project=')) flags.project = arg.slice('--project='.length)
		else if (arg.startsWith('--endpoint=')) flags.endpoint = arg.slice('--endpoint='.length)
	}
	return flags
}

process.exit(await main(process.argv.slice(2)))
