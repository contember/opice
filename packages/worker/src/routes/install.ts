/**
 * `GET /install.md` — the onboarding guide a user pastes into Claude Code as
 * "Fetch instructions from <origin>/install.md". It's written *to* the agent
 * running inside the user's project repo. It is split into two phases on
 * purpose: Phase A wires opice and *proves the reporting pipeline* with a
 * throwaway test that does not touch the user's app or infra; Phase B is the
 * infra-heavy part (run the real app, author real scenarios). Served as plain
 * markdown.
 *
 * The platform origin is injected so links/commands point at this deployment.
 */
import type { Services } from '../services'

export function handleInstallMd(request: Request, _services: Services): Response {
	const origin = new URL(request.url).origin
	return new Response(renderInstallMd(origin), {
		headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
	})
}

function renderInstallMd(origin: string): string {
	return `# Opice integration — kickoff (for Claude Code)

You are running inside a user's project repository. Your job is to wire up
**opice** — an AI-driven E2E browser test harness that streams results to a
central dashboard at \`${origin}\`. Work *with* the user, and **confirm before
any outward or destructive step** (pushing secrets, committing, force-anything).

This guide has **two phases**, and the order matters:

- **Phase A — wire opice and *prove the pipeline*.** Get deps, config, skills
  in place and run **one throwaway test against a public page** (no app, no
  infra) whose only job is to confirm a run reaches the dashboard. Reporting is
  a cross-origin POST from the test process and fails *silently* if anything in
  the way blocks it — so you verify it in isolation before adding any of the
  user's own variables.
- **Phase B — set up the app and author real scenarios.** The infra-heavy part:
  run the real app, wire CI, write scenarios for actual flows.

**Do not start Phase B until Phase A's run is visible on the dashboard.** Read
the whole guide first, then do the steps in order. Stop and ask if a step's
assumption doesn't hold.

---

# Phase A — wire opice and prove the pipeline

## A0. Find the DSN

The user just created a project in the opice dashboard and was told to save an
\`OPICE_DSN\` into their local \`.env\`. Confirm it's there:

\`\`\`
OPICE_DSN=https://<apiKey>@<host>/<slug>
\`\`\`

If \`.env\` has no \`OPICE_DSN\`, ask the user to paste it. Parse it:
- **apiKey** = the userinfo (before \`@\`) — secret, treat as a credential
- **host** = the endpoint (\`https://<host>\`) — should be \`${origin}\`
- **slug** = the first path segment — the project id

Also confirm \`.env\` is gitignored. If not, add it before doing anything else.

## A1. Add the opice dependencies

- **\`@opice/harness\`** — the generated tests import from it
  (\`import { browserTest, el, tid, step } from '@opice/harness'\`).
- **\`@opice/cli\`** — the \`opice\` command (\`init\`, \`install-skills\`, \`test\`).

\`\`\`bash
bun add -d @opice/harness @opice/cli    # or: npm i -D / pnpm add -D
\`\`\`

The CLI then runs via \`bunx opice …\` (or \`npx\`/\`pnpm exec\`).

> **Heads-up — bun version.** \`@opice/harness\` uses the \`beforeAll(fn, timeout)\`
> hook signature. Older bun (≤ 1.3.0) rejects it with *"beforeAll() expects a
> function as the second argument"*. If the repo pins an old bun (e.g. a
> \`packageManager: bun@1.3.0\` field that \`setup-bun\` honors), use a recent bun
> for the test runner.

## A2. Scaffold config

\`\`\`bash
bunx opice init --project=<slug> --endpoint=<host>
\`\`\`

This writes \`opice.config.json\`. (Hold off on \`--with-workflow\` — the CI
workflow is app-specific and belongs to Phase B.)

## A3. Install the opice skills + agent — into this repo

\`\`\`bash
bunx opice install-skills
\`\`\`

Writes \`opice-author\`, \`opice-plan\`, \`opice-batch\`, \`opice-reeval\` and the author
agent into **this project's** \`.claude/skills\` and \`.claude/agents\`. Make sure
those paths are **not** gitignored. Tell the user to **restart Claude Code** so
they load.

## A4. ✅ Prove the pipeline — a throwaway smoke test (NO app, NO infra)

This step exists to confirm, in isolation, that a run actually reaches the
dashboard — *before* you depend on the user's app or infra. Write a tiny test
that snapshots a stable public page:

\`\`\`ts
// tests/browser/_opice-smoke.test.ts  (throwaway — delete after this step)
import { test } from 'bun:test'
import { browserTest, el, expect } from '@opice/harness'

browserTest({ name: 'opice pipeline smoke', url: 'https://example.com' }, () => {
	test('example.com renders', async () => {
		await expect(el('main h1')).toContainText('Example Domain', { timeout: 20_000 })
	})
})
\`\`\`

You'll need \`agent-browser\` on PATH (\`bun add -g agent-browser && agent-browser install\`),
then run it through the reporter:

\`\`\`bash
bunx opice test tests/browser/_opice-smoke.test.ts
\`\`\`

**This step passes only when BOTH are true:**
1. the command prints \`[opice] View run: ${origin}/p/<slug>/r/<id>\`, and
2. that run is visible on the dashboard.

If you instead see \`1 pass\` **without** a \`View run:\` line, or a
\`[opice] reporter could not reach the platform …\` warning, the test passed but
**nothing was recorded** — STOP and fix the wiring (see *Gotchas* below). Do not
move on to Phase B until this run shows up on the dashboard.

Once it's confirmed, **delete \`_opice-smoke.test.ts\`** — it has served its
purpose.

---

# Phase B — set up the app and author real scenarios

Only start this once Phase A's run is on the dashboard.

1. **Run the app locally.** Find the dev command and the URL/port. This is the
   infra-heavy part (databases, services, env). Get to where you can open the
   app in a browser.
2. **Wire CI.** Generate the workflow with \`bunx opice init --with-workflow\` (or
   hand-write \`.github/workflows/opice.yml\`) and adapt it to *this* app: how the
   stack starts, the readiness wait, the port / \`PLAYGROUND_URL\`, and the test
   path. Push the DSN as a repo secret — **confirm with the user first**:
   \`\`\`bash
   gh secret set OPICE_DSN --body "<the OPICE_DSN value from .env>"
   \`\`\`
   Never echo the secret into logs or commits.
3. **Author real scenarios.** Use **opice-plan** (phase 1) to draft a skeleton
   \`*.test.ts\` for a core flow (login, main happy path) — pending \`step\` stubs
   with \`intent\`; review it with the user. Then **opice-author** (phase 2) to
   fill the step bodies in place by walking the live app, and verify it passes.
   Confirm each new run shows on the dashboard too.
4. **Commit** the tests, \`opice.config.json\`, the workflow, and the installed
   \`.claude/\` extensions — atomically, with the user's review.

---

## Gotchas — "the test passes but nothing shows on the dashboard"

Reporting is a **cross-origin POST from the bun test process**, and reporter
errors are swallowed so the test keeps running. So a passing test can hide a
broken pipeline. The usual causes:

- **Your test runner installs a DOM or mocks fetch.** A global test setup
  (bunfig \`[test].preload\`, vitest/jest \`setupFiles\`) that registers
  happy-dom/jsdom or stubs \`fetch\`/network replaces the global \`fetch\` with one
  bound to a same-origin policy. The reporter's cross-origin POST to the
  platform is then blocked (you'll see \`Cross-Origin Request Blocked\` /
  \`OPTIONS … 401\`). **Fix:** scope that setup so it does *not* apply to your
  browser e2e dir, e.g.:
  \`\`\`ts
  // only register the DOM for unit tests, not the real-browser e2e suite
  if (!process.argv.some(a => a.includes('/tests/browser/'))) {
  	GlobalRegistrator.register({ url: 'http://localhost/' })
  }
  \`\`\`
- **No \`View run:\` line / a \`reporter could not reach the platform\` warning.**
  That means nothing was recorded. Check the api key in \`OPICE_DSN\` (a 401 is a
  bad/expired key) and that the endpoint is reachable.
- **Old bun** — see the heads-up in A1.

## Notes

- **DSN model:** \`OPICE_DSN\` is the one value to set (locally + CI). Individual
  \`OPICE_*\` vars override it if present.
- **Auth/roles:** the dashboard is email+password (BetterAuth); accounts are
  operator-created and default to the \`admin\` role. Reporting authenticates with
  the project's write API key (the \`OPICE_DSN\`). Shareable read-only links are
  minted per-run from the run page and carry a \`?token=…\` scoped to that one run.
- Done well, the loop is: write a scenario → author a test → CI runs it
  deterministically → results land in the dashboard.
`
}
