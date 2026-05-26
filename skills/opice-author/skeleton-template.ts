import { browserTest, invariant, step } from '@opice/harness'

/**
 * PHASE-1 SKELETON — written by `opice-plan`, filled in by `opice-author`.
 *
 * This is a real, type-checking, runnable `*.test.ts`, but **non-executable**
 * in the sense that no step has a body yet: every `step(name, { intent, hint })`
 * is a *pending* stub. Running it under `bun test` passes but prints a
 * "N pending step(s)" warning — it is not done.
 *
 * The scenario file IS the spec: there is no separate `.md`. What used to live
 * in a scenario's prose now lives here as durable, machine-relevant data:
 *   - scenario metadata (the FIRST arg): name, url, feature, seeds, roles
 *   - per-step `intent`: the durable "why" — preserved verbatim into phase 2
 *   - per-step `hint`: instructions to the authoring agent — DROPPED once filled
 *   - `invariant.todo(...)`: acceptance properties to enforce, promoted in phase 2
 *
 * A pending stub has two flavours:
 *   - plain `step(name, { intent, hint })` — awaiting a test (the feature EXISTS,
 *     opice-author just hasn't authored it yet).
 *   - `step.blocked(name, reason, { intent })` — can't be authored yet because
 *     the app feature ISN'T BUILT. The dashboard shows it as blocked (amber)
 *     with the reason, distinct from a plain todo.
 *
 * A human reviews THIS file (cheap to read) before `opice-author` turns the
 * stubs into real interactions.
 */

browserTest(
	{
		name: '<Short scenario title>',
		// Deepest stable route the flow lives on — auth is a precondition, not a step.
		url: 'http://localhost:15180/<deep-link-route>',
		// hash: '<playground-hash-or-omit>',
		feature: '<requirement-id-or-omit>',
		// Machine-checkable preconditions — name the idempotent, composable seeds.
		seeds: ['<seed-if-needed>'],
		roles: ['<acting-role-if-relevant>'],
		// setup: () => mintTokens(...),  // optional: one-time precondition (auth, …)
		// retries: <N>,                  // optional: re-run on failure (fresh browser per attempt)
	},
	// The async body IS the walkthrough — browserTest owns the single test() call,
	// so meta.retries/timeout apply and each retry attempt gets a fresh browser.
	async () => {
		// Each pending step: `intent` is the durable why (survives into the
		// authored test); `hint` tells opice-author what to actually do here.
		await step('<step 1 — observable outcome>', {
			intent: '<why this step exists / what it proves>',
			hint: '<what to do on the page: click X, expect Y visible>',
		})

		await step('<step 2>', {
			intent: '<durable rationale>',
			hint: '<concrete action + assertion to author>',
		})

		// A step the feature doesn't support yet — can't be authored until it's
		// built. Shows as 'blocked' (amber) on the dashboard, not a plain todo.
		await step.blocked('<step 3 — not buildable yet>', '<what is missing in the app>', {
			intent: '<what it will prove once the feature lands>',
		})

		// Scenario-level acceptance, independent of the procedural steps.
		// opice-author promotes this to `invariant(name, fn)` once it knows how
		// to enforce it — or `invariant.fixme(name, reason, fn)` if it can't
		// hold yet (e.g. a security property deferred to a ticket).
		await invariant.todo(
			'<the property that must always hold>',
			'<how to check it — the hint opice-author wires up>',
		)
	},
)
