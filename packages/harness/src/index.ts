export { el, tid, waitFor, wait, evalJs, screenshot } from './element.js'

export { byLabel, byRole, byText } from './accessible.js'

export { back, currentPath, currentUrl, forward, open, reload } from './navigation.js'

export { getPage, getContext } from './context.js'

export { browserTest, DEFAULT_WALKTHROUGH_TIMEOUT_MS, invariant, step } from './scenario.js'
export type { BrowserTestMeta, StepContract } from './scenario.js'

export {
	DEFAULT_SCENARIO_TIER,
	DEFAULT_SELECTED_TIER,
	isTierSkipped,
	normalizeTier,
	parseSelectedTier,
	resolveSelectedTier,
	TIER_ORDER,
} from './tier.js'
export type { SelectedTier, Tier } from './tier.js'

export { getReporter, setReporter, configureFromEnv } from './reporter.js'
export type { Reporter, ReporterConfig, StepEvent, ScenarioStart, ScenarioSkip, ScenarioFinish, VideoUpload } from './reporter.js'
export { FileReporter } from './file-reporter.js'

export { parseOpiceDsn } from './dsn.js'
export type { OpiceDsn } from './dsn.js'

export { command, call, runCommand, makeCtx, loadUserCommands, findUserCommandsFile, z } from './command.js'
export type { Command, CommandCtx } from './command.js'

export { loadUserSetup, findUserSetupFile } from './setup.js'
export type { BrowserSetup } from './setup.js'

// Playwright's web-first `expect` (retrying locator matchers + generic matchers)
// works under `bun:test`; re-export it so tests use a single `expect`.
export { expect } from '@playwright/test'

// The DSL returns Playwright Locators directly — re-export the type.
export type { Locator } from 'playwright'
