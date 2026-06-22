#!/usr/bin/env bun
import { failuresCommand } from './commands/failures'
import { initCommand } from './commands/init'
import { installSkillsCommand } from './commands/install-skills'
import { testCommand } from './commands/test'

const HELP = `opice — AI-driven E2E browser test harness

Usage: opice <command> [options]

Commands:
  init [--project=SLUG] [--endpoint=URL] [--with-workflow]
      Scaffold opice.config.json in the current project. Pass
      --with-workflow to also drop a .github/workflows/opice.yml.

  test [--retries=N] [--tier=NAME] [--fail-on-report-error] [--report[=FILE]] [bun test args...]
      Wrapper around 'bun test' that exports OPICE_* env vars from
      opice.config.json + git so the harness reporter streams results
      to the platform. All trailing args pass through to bun test.
      --retries=N sets a default retry budget for every scenario (a
      flaky scenario that fails then passes is reported as flaky, not
      failed). Falls back to "retries" in opice.config.json; a
      per-scenario walkthrough/meta retries overrides both.
      --tier=NAME runs a test tier (critical < standard < extended);
      selection is a threshold, so --tier=standard runs critical +
      standard. Scenarios above it are reported "skipped", not run.
      Falls back to OPICE_TIER, then "tier" in opice.config.json;
      omit to run everything.
      --fail-on-report-error exits non-zero if reporting to the platform
      fails (default: reporting is best-effort and never reddens CI).
      Use it so a bad token / unreachable endpoint can't leave CI green
      while nothing reaches the dashboard. Falls back to
      OPICE_REPORT_STRICT, then "failOnReportError" in opice.config.json.
      --report[=FILE] writes a local HTML report — the dashboard view,
      offline, no platform credentials — instead of streaming results to
      the platform. A bare --report defaults to .opice/report.html;
      --report=FILE picks another path (use this form so it doesn't
      swallow a following bun test-file arg). Screenshots are written to
      a <report>-assets/ folder beside it, so move the two together.
      Multiple test files aggregate into one report.

  failures <run-url|run-id> [--json]
      Pull a failed run's details (failed scenarios, the failing step,
      error, screenshot URL, and source files) for the re-eval workflow.
      Read token comes from the URL's ?token=, OPICE_READ_TOKEN, or
      OPICE_READ_DSN (a read-only project credential).

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
