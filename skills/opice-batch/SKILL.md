---
name: opice-batch
description: >
  Author (or re-author) many opice tests at once by fanning out one
  `opice-author` agent per `*.scenario.md`. Use when there are more scenarios
  than fit comfortably in a single context — e.g. "author all scenarios in
  tests/browser", "generate tests for every *.scenario.md". Caps concurrency,
  isolates each agent's browser session, and collects a pass/fail table.

  Trigger on "/opice-batch", "author all the opice scenarios", "generate tests
  for these scenarios", or any request to author more than a couple at once.
allowed-tools: Agent, Bash(opice-browser:*), Bash(bun:*), Read, Glob, Grep
---

# opice-batch — author many scenarios via parallel agents

Authoring 100 scenarios in one context is impossible — each one fills the
context with browser snapshots. So this skill **fans out**: one `opice-author`
agent per scenario, each with its own browser session and its own context. The
orchestrator (you) only holds the verdicts.

## Inputs

- **scenarios**: a directory or glob of `*.scenario.md` (e.g. `tests/browser/`).
- **playground URL**: from each scenario's `URL:`, else `PLAYGROUND_URL`, else ask.
- **concurrency**: how many authors run at once. Default **4**. Real browsers are
  heavy — don't go above ~5 unless the user insists and the machine can take it.

## Workflow

### 1. Collect the work

- Glob the scenario files. List them. Confirm the set with the user if it's
  large or the output paths would overwrite existing tests.
- Confirm the playground is running (`curl -sf <URL>`). If it isn't, start it or
  tell the user — don't dispatch agents at a dead app.

### 2. Fan out, capped

Dispatch `opice-author` agents (subagent_type `opice-author`), **at most
`concurrency` at a time**, in a single message per wave (multiple Agent tool
calls in one turn run concurrently). Give each agent:

- the one scenario file path it owns;
- the playground URL;
- a **unique session name**: `opice-author-<n>` (n = the scenario's index). This
  is what keeps their browsers from colliding — never reuse a session across
  agents running at the same time.

> Many scenarios, few machines: prefer waves of `concurrency` agents over
> launching all N at once. For very large sets you may instead give each agent a
> *small chunk* of scenarios to author sequentially (reusing its one session) —
> this amortizes browser startup. One scenario per agent is the simpler default;
> chunk only when N is large.

### 3. Collect verdicts

Each agent returns `{ scenario, test, result, reason? }`. Build a table:

```
✓ checkout.scenario.md        → checkout.test.ts        passed
✓ admin-users.scenario.md     → admin-users.test.ts     passed
✗ search.scenario.md          → search.test.ts          blocked: step 4 — no testid on result row
✗ profile.scenario.md         → —                       failed: app didn't show the saved toast
```

### 4. Summarize

- Counts: N passed / failed / blocked.
- For each non-pass: the scenario, the failing step, and the one-line reason.
- Group the failures by likely cause (missing testids → ask user to add;
  app-behaviour mismatch → possible real bug or wrong scenario; timing → may
  need waitFor). 
- **Do not commit.** Tell the user which tests are ready and which need a human
  decision.

## Notes

- If an agent reports a scenario blocked on a missing `data-testid`, collect all
  such cases and surface them together — it's usually one batch of testids the
  user adds before a re-run.
- Re-running: this skill is also how you re-author a whole suite after a UI
  refactor. Same flow; expect more failures, triage them as above.
- This skill never edits tests itself — it only orchestrates `opice-author`
  agents. Fixing an individual failing test live is `opice-author`'s job;
  diagnosing a failed CI run is `opice-reeval`'s.
