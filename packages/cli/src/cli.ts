#!/usr/bin/env bun
import { failuresCommand } from './commands/failures'
import { initCommand } from './commands/init'
import { installSkillsCommand } from './commands/install-skills'
import { testCommand } from './commands/test'
import { tokensCommand } from './commands/tokens'
import { usersCommand } from './commands/users'

const HELP = `opice — AI-driven E2E browser test harness

Usage: opice <command> [options]

Commands:
  init [--project=SLUG] [--endpoint=URL] [--with-workflow]
      Scaffold opice.config.json in the current project. Pass
      --with-workflow to also drop a .github/workflows/opice.yml.

  test [--retries=N] [bun test args...]
      Wrapper around 'bun test' that exports OPICE_* env vars from
      opice.config.json + git so the harness reporter streams results
      to the platform. All trailing args pass through to bun test.
      --retries=N sets a default retry budget for every scenario (a
      flaky scenario that fails then passes is reported as flaky, not
      failed). Falls back to "retries" in opice.config.json; a
      per-scenario walkthrough/meta retries overrides both.

  failures <run-url|run-id> [--json]
      Pull a failed run's details (failed scenarios, the failing step,
      error, screenshot URL, and source files) for the re-eval workflow.
      Read token comes from the URL's ?token=, OPICE_READ_TOKEN, or
      OPICE_READ_DSN (a read-only project credential).

  tokens create [--project=SLUG] [--capability=read|write] [--label=...] [--expires-days=N]
  tokens list [--project=SLUG]
  tokens revoke <token-id>
      Manage API tokens. Needs the admin token (--admin-token or
      OPICE_ADMIN_TOKEN) and the platform endpoint (--endpoint,
      OPICE_ENDPOINT, or opice.config.json). 'create' defaults to a
      project-scoped read token and prints a ready OPICE_READ_DSN an
      authoring agent can drop into .env to read results.

  users create <email> [--password=...] [--name=...] [--endpoint=URL] [--admin-token=TOKEN]
      Create a dashboard login (admin role by default). Needs the bootstrap
      admin token (--admin-token or OPICE_ADMIN_TOKEN) and the platform endpoint
      (--endpoint, OPICE_ENDPOINT, or opice.config.json). A password is
      generated and printed if you don't pass one.

  install-skills [--global] [--ref=BRANCH]
      Install opice's Claude Code skills + author agent into this project's
      .claude/ (or ~/.claude with --global), fetched from GitHub. Restart
      Claude Code afterwards to load them.

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
		case 'users':
			return usersCommand(rest)
		case 'tokens':
			return tokensCommand(rest)
		case 'install-skills':
			return installSkillsCommand(rest)
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
