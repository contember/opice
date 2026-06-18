import { createRequire } from 'node:module'
import path from 'node:path'
import { closePage, getContext, launchPage } from './context.js'
import { screenshot } from './element.js'
import { getReporter, isStrictReporting, type Reporter } from './reporter.js'
import { loadUserSetup } from './setup.js'
import { isTierSkipped, normalizeTier, parseSelectedTier, type Tier, TIER_ORDER } from './tier.js'

/**
 * `bun:test` is resolved lazily, at the moment `browserTest` registers a
 * scenario — never at module load. That keeps `@opice/harness` importable
 * under plain Node (the `opice-browser` authoring daemon imports the command
 * registry from this package and runs on Node, where `bun:test` doesn't
 * exist). Tests still register synchronously: `require` is sync under Bun.
 */
const require = createRequire(import.meta.url)
function bunTest(): typeof import('bun:test') {
	return require('bun:test') as typeof import('bun:test')
}

const PLAYGROUND_URL = process.env['PLAYGROUND_URL'] ?? 'http://localhost:15180'

/**
 * Scenario metadata — the **first** argument to `browserTest`.
 *
 * This is the durable, machine-relevant context an opice scenario carries
 * independent of its concrete steps: where it runs, what it presupposes, what
 * requirement it covers. It is written in **phase 1** (planning, `opice-plan`)
 * and preserved through **phase 2** (authoring, `opice-author`) — the scenario
 * file IS the spec, so this metadata never lives in a separate `.md` that can
 * drift from the test.
 *
 * The rule of thumb for what belongs here vs. a code comment: *does anything
 * other than a human read it?* Seeds (a precondition a runner could verify),
 * the feature id (grouping on the dashboard), the acting roles — yes, so they
 * are first-class fields. Background rationale that only a human reads stays a
 * comment next to the relevant step.
 */
export interface BrowserTestMeta {
	/** Scenario name — becomes the `describe()` title. Required. */
	name: string
	/** Override base URL (defaults to the `PLAYGROUND_URL` env var). */
	url?: string
	/** Hash fragment appended to the base URL (e.g. `'datagrid'`). */
	hash?: string
	/** Feature / requirement id this scenario covers (e.g. `'F-SML-03a'`). */
	feature?: string
	/**
	 * Test tier — *when* this scenario runs (critical < standard < extended).
	 * A run selects a tier via `OPICE_TIER` / `opice test --tier`; selection is a
	 * threshold (running `standard` runs critical + standard). A scenario above
	 * the selected tier is **skipped**: reported as `skipped` (so it still shows
	 * on the dashboard) but never opens a browser. Defaults to `standard`.
	 *
	 *   critical — the must-pass core, every push
	 *   standard — the normal suite (default), PRs / merges
	 *   extended — slow / edge / expensive, nightly or on demand
	 */
	tier?: Tier
	/**
	 * Seeds that must be loaded for this scenario to run — machine-checkable
	 * preconditions, not prose. e.g. `['initial-data', 'crm-master-data']`.
	 */
	seeds?: string[]
	/** Identities / roles the scenario acts as, e.g. `['crmOperator']`. */
	roles?: string[]
	/**
	 * One-time scenario setup, run once before the walkthrough (in `beforeAll`) —
	 * the place for "establish a precondition the steps assume", e.g. minting
	 * auth tokens. Replaces a hand-written `beforeAll` in the body form. Runs
	 * before any browser navigation, so it can register cookies/identity the
	 * first paint needs.
	 */
	setup?: () => void | Promise<void>
	/**
	 * One-time scenario teardown, run once after the walkthrough (in `afterAll`),
	 * after the browser is closed. The symmetric counterpart to {@link setup} —
	 * the place to clean up data a scenario created against a shared/persistent
	 * DB (e.g. delete per-run rows by a unique code) so it doesn't accumulate
	 * across local runs. Best-effort: a throw here is logged as a warning and
	 * does NOT fail an otherwise-green run (cleanup is hygiene, not an
	 * assertion). Runs once per scenario regardless of the retry count.
	 */
	teardown?: () => void | Promise<void>
	/**
	 * Per-scenario retry budget (body form only). A flaky scenario that fails
	 * then passes within the budget is reported as **passed but flaky** (the
	 * dashboard badges it). Each attempt gets a fresh browser + a clean
	 * navigation, so a retry can't inherit the failed attempt's page state.
	 *
	 * Omit to inherit the global default (`opice test --retries=N` / `bun test
	 * --retry=N`). Ignored by the legacy registrar form (it can't be retried
	 * cleanly — it shares one browser across its `test()` blocks).
	 */
	retries?: number
	/**
	 * Per-scenario timeout (ms) for the walkthrough body. Defaults to
	 * {@link DEFAULT_WALKTHROUGH_TIMEOUT_MS}. Body form only.
	 */
	timeout?: number
}

/**
 * Default timeout for a walkthrough body. A real browser walk — first page
 * load, async data, a dev server compiling a chunk on first hit — easily
 * exceeds bun's 5s default; each retrying assertion still bounds itself.
 */
export const DEFAULT_WALKTHROUGH_TIMEOUT_MS = 60_000

/**
 * Best-effort capture of the `*.test.ts` path that called `browserTest`, by
 * walking the stack for the first `.test.` frame. Reported so a failed
 * scenario links back to its source file. Repo-relative when possible.
 */
function captureTestFile(): string | undefined {
	const stack = new Error().stack
	if (!stack) return undefined
	for (const line of stack.split('\n')) {
		const match = line.match(/\(?((?:file:\/\/)?\/[^\s():]+\.test\.[tj]sx?)/)
		if (match?.[1]) {
			const abs = match[1].replace(/^file:\/\//, '')
			try {
				const rel = path.relative(process.cwd(), abs)
				return rel.startsWith('..') ? abs : rel
			} catch {
				return abs
			}
		}
	}
	return undefined
}

// The tier this run selected (OPICE_TIER), resolved + cached once. An
// unrecognized value warns once and falls back to running everything.
let cachedSelectedTier: Tier | undefined
function getSelectedTier(): Tier {
	if (cachedSelectedTier === undefined) {
		const parsed = parseSelectedTier()
		if (!parsed.recognized) {
			console.warn(
				`[opice] unknown OPICE_TIER="${process.env['OPICE_TIER']}" — running all tiers `
				+ `(use one of: ${TIER_ORDER.join(', ')}).`,
			)
		}
		cachedSelectedTier = parsed.tier
	}
	return cachedSelectedTier
}

// Names of scenarios skipped by the tier filter, summarized once at process
// exit so a tiered run prints "N skipped" instead of a line per scenario.
const skippedScenarioNames: string[] = []
let skipSummaryHooked = false
function noteSkipped(name: string): void {
	skippedScenarioNames.push(name)
	if (skipSummaryHooked) return
	skipSummaryHooked = true
	process.on('exit', () => {
		if (skippedScenarioNames.length === 0) return
		console.warn(
			`[opice] ${skippedScenarioNames.length} scenario(s) skipped — above the selected `
			+ `tier '${getSelectedTier()}' (OPICE_TIER).`,
		)
	})
}

let currentScenarioId: string | null = null
let currentScenarioStart: number = 0
let currentScenarioFailures = 0
let currentScenarioPending = 0
// Monotonic per-scenario step counter. Assigned synchronously at each step()
// call so order reflects authoring order — step records are POSTed
// fire-and-forget and would otherwise be sequenced by arrival order at the
// worker, which screenshot-encoding latency can reshuffle.
let currentScenarioStepSeq = 0
// 0-based index of the current attempt. In the body form the walkthrough wrapper
// bumps it on every (re-)invocation, so steps carry the attempt that produced
// them and the dashboard shows only the final one. The legacy form never
// retries, so it stays 0.
let currentAttempt = 0

/**
 * Register a top-level browser test scenario. Two forms, picked automatically:
 *
 * **Body form (preferred)** — pass an **async** function; it IS the walkthrough:
 *
 *     browserTest({ name: '…', retries: 2, setup: () => mintTokens() }, async () => {
 *       await step('…', async () => { … })
 *     })
 *
 * `browserTest` owns the single `test('walkthrough', …)` call, so it honours
 * `meta.retries` (bun `{ retry }`) and `meta.timeout`. Each attempt opens a
 * **fresh** browser context + clean navigation, so a retry never inherits the
 * failed attempt's page state. `meta.setup` runs once before the walkthrough.
 *
 * **Legacy registrar form** — pass a **sync** function that registers its own
 * `beforeAll`/`test`/`describe` blocks (the old multi-test pattern). The browser
 * is launched once in `beforeAll` and shared across those blocks. It can't be
 * retried cleanly (shared state), so `meta.retries` is ignored.
 *
 * The two are told apart by whether `fn` is an `AsyncFunction`: a walkthrough
 * body always awaits its steps; a registrar never needs to be async.
 *
 * Metadata is the **first** argument (`{ name, url, hash, feature, seeds, roles,
 * setup, retries, timeout }`); `name` is required.
 */
export function browserTest(meta: BrowserTestMeta, fn: () => void | Promise<void>): void {
	if (typeof meta === 'string') {
		// Migration aid: the old signature was `browserTest(name, fn, options)`.
		throw new Error(
			'opice: browserTest now takes metadata first — browserTest({ name, url, hash, … }, fn). '
			+ `Got a string name (${JSON.stringify(meta)}); wrap it: browserTest({ name: ${JSON.stringify(meta)} }, fn).`,
		)
	}
	if (!meta?.name) {
		throw new Error('opice: browserTest requires a `name` in its metadata — browserTest({ name: "…" }, fn).')
	}
	const reporter = getReporter()
	const testFile = captureTestFile()
	const { describe, beforeAll, afterAll, test } = bunTest()
	// An async fn is the walkthrough body (browserTest owns its test()); a sync
	// fn is the legacy registrar (it registers its own test()/hooks).
	const isBody = fn.constructor.name === 'AsyncFunction'

	// Tier gate: a scenario above the selected tier is registered but not run —
	// reported `skipped` so the dashboard shows the full inventory.
	const scenarioTier = normalizeTier(meta.tier)
	if (isTierSkipped(scenarioTier, getSelectedTier())) {
		registerSkipped(meta, scenarioTier, testFile, reporter)
		return
	}

	describe(meta.name, () => {
		beforeAll(async () => {
			currentScenarioStart = Date.now()
			currentScenarioPending = 0
			currentScenarioFailures = 0
			currentScenarioStepSeq = 0
			currentAttempt = 0
			try {
				currentScenarioId = await reporter.startScenario({
					name: meta.name,
					hash: meta.hash,
					testFile,
					feature: meta.feature,
					seeds: meta.seeds,
					roles: meta.roles,
					tier: scenarioTier,
				})
			} catch {
				currentScenarioId = null
			}
			try {
				// One-time precondition (mint tokens, …), before any navigation.
				if (meta.setup) await meta.setup()
				// Body form opens the browser per attempt (in the test wrapper);
				// the legacy registrar shares one browser, launched here once.
				if (!isBody) await openScenario(meta)
			} catch (e) {
				// Setup failed before any step ran. bun:test does NOT run afterAll
				// when beforeAll throws, so the scenario started above would otherwise
				// sit on the dashboard as 'running' forever — record a synthetic failed
				// step, finish it as failed here, then re-throw so the run stays red.
				await recordSetupFailure(reporter, e)
				if (currentScenarioId) {
					try {
						await reporter.finishScenario({
							scenarioId: currentScenarioId,
							status: 'failed',
							durationMs: Date.now() - currentScenarioStart,
							attempts: 1,
						})
					} catch {
						// best-effort
					}
					currentScenarioId = null
				}
				throw e
			}
		}, 30_000)

		afterAll(async () => {
			try {
				await closePage()
			} catch {
				// ignore close errors
			}
			// Best-effort data cleanup, symmetric to meta.setup. Runs once after the
			// browser is closed; a failure is logged but never reds an otherwise-green
			// run (cleanup is hygiene, not an assertion).
			if (meta.teardown) {
				try {
					await meta.teardown()
				} catch (e) {
					console.warn(`[opice] scenario "${meta.name}" teardown failed (ignored): ${e instanceof Error ? e.message : String(e)}`)
				}
			}
			// A scenario still carrying unfilled (pending) steps is a phase-1
			// skeleton that was run before authoring. It's not a failure, but it's
			// not done either — make it loud so a half-authored test isn't mistaken
			// for a passing one.
			if (currentScenarioPending > 0) {
				console.warn(
					`[opice] scenario "${meta.name}" has ${currentScenarioPending} pending step(s) — `
					+ 'authored skeleton, not yet filled in by opice-author. The body did NOT run.',
				)
			}
			if (currentScenarioId) {
				// Drain pending step records (incl. their screenshot uploads)
				// before marking the scenario done. step() fires recordStep
				// fire-and-forget; the test process would otherwise exit while
				// those requests were still in flight.
				try {
					await reporter.flush()
				} catch {
					// best-effort
				}
				const durationMs = Date.now() - currentScenarioStart
				const status = currentScenarioFailures > 0 ? 'failed' : 'passed'
				try {
					// attempts = final attempt index + 1. A passed scenario with
					// attempts > 1 failed at least once first → flaky.
					await reporter.finishScenario({ scenarioId: currentScenarioId, status, durationMs, attempts: currentAttempt + 1 })
				} catch {
					// best-effort
				}
			}
			currentScenarioId = null
			// Strict reporting: a swallowed report failure (here or in any earlier
			// hook/step) must turn the run red. afterAll always runs (beforeAll
			// catches its own report failures), so throwing here is enough to make
			// bun exit non-zero even when every assertion passed. The detail was
			// already logged at the point of failure (reporter.noteFailure).
			if (isStrictReporting() && reporter.hadFailures()) {
				throw new Error(
					`[opice] reporting to the platform failed and strict reporting is on `
					+ `(OPICE_REPORT_STRICT / opice test --fail-on-report-error) — failing the run. `
					+ `See the [opice] reporter error(s) above for the cause.`,
				)
			}
		}, 30_000)

		if (isBody) {
			const body = fn as () => Promise<void>
			const timeout = meta.timeout ?? DEFAULT_WALKTHROUGH_TIMEOUT_MS
			// Only set `retry` when a budget is configured — leaving it unset lets
			// bun's global `--retry` default apply; passing `retry: 0` overrides it.
			const testOptions = meta.retries === undefined ? { timeout } : { timeout, retry: meta.retries }
			// bun re-runs the test body for every retry attempt; `attempt` counts
			// those invocations (0-based). Each opens a fresh browser + navigation.
			let attempt = -1
			test('walkthrough', async () => {
				attempt++
				currentAttempt = attempt
				currentScenarioFailures = 0
				currentScenarioStepSeq = 0
				currentScenarioPending = 0
				try {
					await openScenario(meta)
				} catch (e) {
					// Setup failed: record it (afterAll finishes the scenario) and fail
					// the attempt so bun retries or, once spent, leaves the run red.
					await recordSetupFailure(reporter, e)
					throw e
				}
				await body()
			}, testOptions)
		} else {
			// Legacy registrar: it registers its own test()/hooks; the shared
			// browser was opened in beforeAll above.
			fn()
		}
	})
}

/**
 * Register a scenario the tier filter excluded. It's reported to the platform as
 * `skipped` (so the dashboard shows it alongside what ran) but never opens a
 * browser. The report runs in a real — instant, browser-free — `test`, not a
 * `test.skip`: bun won't run a describe's hooks if every test in it is skipped,
 * so a skip body is the only place left to POST from. With reporting off (local
 * authoring), the body is a no-op against the NoopReporter.
 */
function registerSkipped(meta: BrowserTestMeta, tier: Tier, testFile: string | undefined, reporter: Reporter): void {
	noteSkipped(meta.name)
	const { describe, test } = bunTest()
	const reason = `tier '${tier}' above the selected tier '${getSelectedTier()}'`
	describe(meta.name, () => {
		test('skipped (tier)', async () => {
			try {
				await reporter.skipScenario({
					name: meta.name,
					hash: meta.hash,
					testFile,
					feature: meta.feature,
					seeds: meta.seeds,
					roles: meta.roles,
					tier,
					reason,
				})
			} catch {
				// Best-effort: reporting a skip must never fail the run.
			}
		})
	})
}

/**
 * Open a fresh isolated browser context + page for `meta` and navigate to its
 * scenario URL. `launchPage()` closes any previous context first, so calling
 * this again (a retry attempt) tears down the failed attempt's page cleanly.
 */
async function openScenario(meta: BrowserTestMeta): Promise<void> {
	const page = await launchPage()
	// Repo-level context setup (browser-setup.ts) runs before the first
	// navigation, so an addInitScript it registers fires before the app's own
	// scripts on first paint.
	const setup = await loadUserSetup()
	if (setup) await setup(getContext())
	const base = meta.url ?? PLAYGROUND_URL
	const url = meta.hash ? `${base}#${meta.hash}` : base
	// `domcontentloaded`, not the default `load`: an SPA paints after its JS runs
	// and may hold `load` on a slow chunk or long-lived connection, so waiting for
	// `load` flakily times out under CI contention. Readiness is handled by the
	// test's retrying assertions.
	await page.goto(url, { waitUntil: 'domcontentloaded' })
}

/**
 * Record a synthetic failed 'scenario setup' step for the current attempt and
 * count it toward scenario failures. Does NOT finish the scenario (the caller
 * decides whether afterAll will, or whether it must finish inline).
 */
async function recordSetupFailure(reporter: Reporter, e: unknown): Promise<void> {
	currentScenarioFailures++
	if (!currentScenarioId) return
	try {
		await reporter.recordStep({
			scenarioId: currentScenarioId,
			attempt: currentAttempt,
			sequence: currentScenarioStepSeq++,
			kind: 'step',
			name: 'scenario setup',
			status: 'failed',
			durationMs: Date.now() - currentScenarioStart,
			error: e instanceof Error ? e.message : String(e),
		})
	} catch {
		// best-effort: reporting the failure must never mask the original error.
	}
}

type StepStatus = 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
type StepKind = 'step' | 'invariant'

/**
 * The durable contract of a step or invariant, separate from its mechanics.
 *
 * `intent` is written in **phase 1** and survives **verbatim** into the
 * authored test — it's the "why this exists / what it proves", the independent
 * statement of intent that the concrete body is checked against. `hint` is
 * phase-1 scaffolding *for the authoring agent* ("what to actually do here");
 * it is consumed when the step is authored and dropped once a body exists.
 */
export interface StepContract {
	/** Durable rationale: why this step/invariant exists, what it proves. */
	intent?: string
	/**
	 * Phase-1 instruction to the authoring agent — what to do on the page here.
	 * Ephemeral: drop it once the body is written.
	 */
	hint?: string
	/**
	 * Human-readable manual line for this step — what a *person* does (or sees)
	 * here, written for the end user, not the machine. Where `intent` is the
	 * machine-facing spec ("why this proves the requirement"), `manual` is the
	 * plain-language instruction a non-technical reader could follow: stupid
	 * simple, in the manual's target language (typically Czech), in the formal
	 * register (vykání). It replaces the `// MANUÁL:` comment that used to sit
	 * above a step — structured data instead of prose buried in the source.
	 *
	 * Durable like `intent`: written in phase 1, preserved (and refined with the
	 * real UI labels) through phase 2. Reported with the step but not yet
	 * surfaced anywhere — stored now, displayed later.
	 */
	manual?: string
}

interface RunUnit {
	kind: StepKind
	name: string
	contract?: StepContract
	/** Present once authored. Absent ⇒ a pending (phase-1) stub. */
	fn?: () => void | Promise<void>
	/**
	 * A human note. With a body (`.fixme`): why a tolerated failure is allowed.
	 * Without a body (`.blocked`): why the stub can't be authored yet (the app
	 * feature isn't implemented). A plain pending stub has no reason.
	 */
	reason?: string
}

async function runUnit(unit: RunUnit): Promise<void> {
	const reporter = getReporter()
	// Capture order at call time, before the fire-and-forget record below.
	const sequence = currentScenarioStepSeq++
	// A reason *with* a body is a .fixme (tolerated failure). A reason *without*
	// a body is .blocked (a pending stub that can't be authored yet).
	const fixme = unit.reason !== undefined && unit.fn !== undefined

	// Phase-1 stub: no body to run. Report it as 'pending' (so the dashboard
	// shows the skeleton — a scenario carrying one reads as 'incomplete') and
	// count it so afterAll can warn. A `reason` here marks it 'blocked' (the
	// feature isn't built); no reason is a plain todo awaiting authoring. No
	// screenshot, zero duration.
	if (!unit.fn) {
		currentScenarioPending++
		if (currentScenarioId) {
			void reporter.recordStep({
				scenarioId: currentScenarioId,
				attempt: currentAttempt,
				sequence,
				kind: unit.kind,
				name: unit.name,
				status: 'pending',
				durationMs: 0,
				intent: unit.contract?.intent,
				manual: unit.contract?.manual,
				reason: unit.reason,
			})
		}
		return
	}

	const start = Date.now()
	let status: StepStatus = 'passed'
	let error: string | undefined
	try {
		await unit.fn()
		// A fixme unit that *passes* is a stale marker: surface it as a
		// 'fixmepass' warning so the author knows they can drop the marker,
		// rather than letting it pass silently.
		if (fixme) status = 'fixmepass'
	} catch (e) {
		error = e instanceof Error ? e.message : String(e)
		if (fixme) {
			// Known / tolerated failure. Record it as 'fixme', but DON'T count it
			// toward scenario failures and DON'T re-throw — that's the whole point
			// of .fixme: the scenario (and the CI run) stay green, the failure
			// surfaces as an amber warning on the dashboard.
			status = 'fixme'
		} else {
			status = 'failed'
			currentScenarioFailures++
			throw e
		}
	} finally {
		const durationMs = Date.now() - start
		let screenshotPath: string | undefined
		try {
			screenshotPath = await screenshot()
		} catch {
			// screenshot failure shouldn't fail the test
		}
		if (currentScenarioId) {
			void reporter.recordStep({
				scenarioId: currentScenarioId,
				attempt: currentAttempt,
				sequence,
				kind: unit.kind,
				name: unit.name,
				status,
				durationMs,
				error,
				intent: unit.contract?.intent,
				manual: unit.contract?.manual,
				reason: unit.reason,
				screenshotPath,
			})
		}
	}
}

type StepBody = () => void | Promise<void>

interface StepFn {
	/** Executable step. */
	(name: string, fn: StepBody): Promise<void>
	/** Phase-1 stub: a step with a contract but no body yet (status: pending). */
	(name: string, contract: StepContract): Promise<void>
	/** Authored step that keeps its durable contract. */
	(name: string, contract: StepContract, fn: StepBody): Promise<void>
}

interface StepExtras {
	fixme: {
		/** Tolerated failure with just a body. */
		(name: string, reason: string, fn: StepBody): Promise<void>
		/**
		 * Tolerated failure that also keeps a durable contract — pass
		 * `{ intent, manual }` before the body so the spec rationale and the
		 * end-user manual line survive on a `.fixme` step too.
		 */
		(name: string, reason: string, contract: StepContract, fn: StepBody): Promise<void>
	}
	/**
	 * A **blocked** pending stub: the step can't be authored yet because the app
	 * feature it covers isn't implemented. Reports as 'pending' with the reason
	 * attached (the dashboard shows it as blocked, distinct from a plain stub
	 * that's merely awaiting a test). `reason` is mandatory — say what's missing.
	 */
	blocked: (name: string, reason: string, contract?: StepContract) => Promise<void>
}

/**
 * A reportable step inside a scenario. Captures duration + screenshot on
 * finish, forwards to the active reporter (no-op unless configured via env).
 *
 * The body may be sync or async; `step` always returns a promise, so call it
 * with `await step('…', async () => { … })`.
 *
 * Three forms:
 * - `step(name, fn)` — executable step (the common case).
 * - `step(name, { intent, hint })` — a **pending** phase-1 stub: declares the
 *   step's intent and what to do, but has no body yet. It does not run and
 *   reports as `pending`; `opice-author` fills in the body.
 * - `step(name, { intent }, fn)` — an authored step that keeps its durable
 *   `intent` (preserved verbatim from phase 1) alongside the body.
 *
 * `step.fixme(name, reason, fn)` marks a **known, tolerated failure**: the body
 * still runs, but a failure inside it does NOT fail the scenario or the CI run —
 * it's reported as an amber warning instead. The `reason` is mandatory (use it
 * to reference a ticket, e.g. 'BUG-123: tax rounding off by 1c'). If a fixme
 * step unexpectedly *passes*, it's flagged too ('fixmepass') so a stale marker
 * doesn't linger. Unlike Playwright's `test.fixme()`, which **skips** the test,
 * `step.fixme` **runs** it — the mandatory reason is there to keep them apart.
 * Pass a contract before the body — `step.fixme(name, reason, { intent, manual },
 * fn)` — to keep the durable `intent` / end-user `manual` on a tolerated step.
 *
 * `step.blocked(name, reason, contract?)` is a pending stub that **can't be
 * authored yet** because the app feature doesn't exist — distinct from a plain
 * `step(name, contract)` stub that's simply awaiting a test. Both report as
 * 'pending' (scenario reads 'incomplete'); the blocked one carries its reason.
 */
export const step: StepFn & StepExtras = Object.assign(
	(name: string, arg2: StepBody | StepContract, arg3?: StepBody): Promise<void> => {
		if (typeof arg2 === 'function') {
			return runUnit({ kind: 'step', name, fn: arg2 })
		}
		return runUnit({ kind: 'step', name, contract: arg2, fn: arg3 })
	},
	{
		fixme: (name: string, reason: string, arg3: StepBody | StepContract, arg4?: StepBody): Promise<void> =>
			typeof arg3 === 'function'
				? runUnit({ kind: 'step', name, reason, fn: arg3 })
				: runUnit({ kind: 'step', name, reason, contract: arg3, fn: arg4 }),
		blocked: (name: string, reason: string, contract?: StepContract): Promise<void> =>
			runUnit({ kind: 'step', name, contract, reason }),
	},
)

/**
 * A scenario-level **invariant** — an acceptance property the scenario
 * enforces, independent of the procedural steps. This is the durable "what
 * must be true" that used to live in a scenario's prose Notes; expressing it as
 * a call keeps it in the one source of truth (the test) instead of a separate
 * `.md` that drifts.
 *
 * A failing `invariant` fails the scenario like any hard assertion — it's an
 * acceptance, not a nicety.
 *
 * - `invariant(name, fn)` — enforced now. Pass a contract first —
 *   `invariant(name, { intent, manual }, fn)` — to attach the durable `intent`
 *   and the end-user `manual` line to the acceptance, exactly like a `step`.
 * - `invariant.todo(name, hint?)` — phase-1 stub: states the acceptance but
 *   isn't wired yet (status: pending). `opice-author` promotes it to an
 *   enforced `invariant(...)` (or an `invariant.fixme(...)` if it can't hold
 *   yet) once it knows how to check it.
 * - `invariant.blocked(name, reason)` — a pending acceptance that can't be
 *   wired yet because the feature it guards isn't implemented (vs `.todo`,
 *   which is merely awaiting authoring). Reports 'pending' with the reason.
 * - `invariant.fixme(name, reason, fn)` — a known-unenforceable acceptance,
 *   tolerated like `step.fixme` (e.g. a security property deferred to a
 *   ticket). The body runs and is expected to fail; the failure is reported as
 *   an amber warning and neither fails the scenario nor the run. Also accepts a
 *   contract before the body: `invariant.fixme(name, reason, { intent, manual },
 *   fn)`.
 */
export const invariant: {
	(name: string, fn: StepBody): Promise<void>
	(name: string, contract: StepContract, fn: StepBody): Promise<void>
	todo: (name: string, hint?: string) => Promise<void>
	blocked: (name: string, reason: string) => Promise<void>
	fixme: {
		(name: string, reason: string, fn: StepBody): Promise<void>
		(name: string, reason: string, contract: StepContract, fn: StepBody): Promise<void>
	}
} = Object.assign(
	(name: string, arg2: StepBody | StepContract, arg3?: StepBody): Promise<void> =>
		typeof arg2 === 'function'
			? runUnit({ kind: 'invariant', name, fn: arg2 })
			: runUnit({ kind: 'invariant', name, contract: arg2, fn: arg3 }),
	{
		todo: (name: string, hint?: string): Promise<void> =>
			runUnit({ kind: 'invariant', name, contract: hint ? { hint } : undefined }),
		blocked: (name: string, reason: string): Promise<void> =>
			runUnit({ kind: 'invariant', name, reason }),
		fixme: (name: string, reason: string, arg3: StepBody | StepContract, arg4?: StepBody): Promise<void> =>
			typeof arg3 === 'function'
				? runUnit({ kind: 'invariant', name, reason, fn: arg3 })
				: runUnit({ kind: 'invariant', name, reason, contract: arg3, fn: arg4 }),
	},
)
