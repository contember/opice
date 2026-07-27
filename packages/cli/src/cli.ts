#!/usr/bin/env bun
import { failuresCommand } from './commands/failures'
import { impactCommand } from './commands/impact'
import { initCommand } from './commands/init'
import { installSkillsCommand } from './commands/install-skills'
import { testCommand } from './commands/test'

const HELP = `opice — AI-driven E2E browser test harness

Usage: opice <command> [options]

Commands:
  init [--project=SLUG] [--endpoint=URL] [--with-workflow]
      Scaffold opice.config.json in the current project. Pass
      --with-workflow to also drop a .github/workflows/opice.yml.

  test [--retries=N] [--tier=NAME] [--select=FILE[,FILE...]] [--impacted[=BASE]] [--footprint[=MODE]] [--fail-on-report-error] [--report[=FILE]] [--video[=DIR]] [bun test args...]
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
      --select=FILE[,FILE...] (repeatable) runs the named scenarios IN
      ADDITION to the tier, deduplicated — a scenario already within the
      tier is not run twice. Use it to run exactly the scenarios a change
      touched on top of the always-on tier, e.g. on a PR:
      --tier critical --select "$(git diff --name-only origin/main...HEAD \\
      -- 'tests/browser/*.test.ts' | paste -sd,)". Falls back to
      OPICE_SELECT. Paths match shape-tolerantly (repo-relative/absolute).
      --impacted[=BASE] asks the platform which scenarios your changes
      reach — matching a git diff against what each scenario touched the
      last time it ran — and folds those test files into --select. BASE
      defaults to the PR base / origin/main. It only ever ADDS to the
      tier: if the platform is unreachable or no footprint has been
      recorded yet, it warns and runs the tier alone, never less.
      Needs OPICE_READ_DSN or OPICE_DSN. See 'opice impact'.
      --footprint[=network|full] records what each scenario touches:
      source files, React components, endpoints and GraphQL models.
      A bare --footprint means full (adds V8 coverage + component
      names to the network listeners; needs a dev server or source
      maps to resolve files). Off by default. This is what builds the
      index --impacted reads, so run it on CI — typically on the
      nightly full-tier run. Falls back to OPICE_FOOTPRINT, then
      "footprint" in opice.config.json. Each scenario's footprint is
      also written to .opice/footprint/<scenario>.json locally.
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
      --video[=DIR] records a screen capture of each scenario's
      walkthrough, saved as <scenario-name>.webm — handy for tutorial
      footage. Off by default (recording is overhead). A bare --video
      writes to opice-videos/; --video=DIR picks another folder. Set
      OPICE_VIDEO_SIZE=WxH (e.g. 1280x720) to fix the recording size.

  failures <run-url|run-id> [--json]
      Pull a failed run's details (failed scenarios, the failing step,
      error, screenshot URL, and source files) for the re-eval workflow.
      Read token comes from the URL's ?token=, OPICE_READ_TOKEN, or
      OPICE_READ_DSN (a read-only project credential).

  impact [--base=REF] [--model=NAME] [--include-loaded] [--json]
      Print the test files your changes reach, one per line — a git diff
      matched against what each scenario touched the last time it ran.
      Pipe it into --select, or use 'opice test --impacted' to do both
      in one step. --model=NAME adds a data model the diff can't express
      (a schema edit). --json prints the full reasoning: which file,
      component or model matched, and how fresh the index is.
      By default a file matches only if the scenario CALLED code in it.
      --include-loaded widens to files it merely imported — a true but
      near-useless signal on an app that evaluates its whole schema and
      component library on load, which is why it's off by default.
      Requires a footprint-collecting run to have happened first
      ('opice test --footprint'); with an empty index it says so rather
      than reporting "nothing is affected".

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
		case 'impact':
			return impactCommand(rest)
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
