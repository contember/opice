---
name: opice-reeval
description: >
  Diagnose and fix a failed opice CI run. Given a failed-run URL (or run id),
  pulls the failure details from the platform, reproduces each failing scenario
  locally in a real browser, and either fixes the test (selector drift, timing)
  or flags a genuine app regression — without ever gutting an assertion just to
  make it pass.

  Trigger when the user says "/opice-reeval <url>", "look at this failed run
  <url>", "this opice run failed, fix it", "re-eval the failing CI", or pastes a
  dashboard run link and asks what broke.
allowed-tools: Bash(opice:*), Bash(bunx opice:*), Bash(opice-browser:*), Bash(bun:*), Bash(gh:*), Bash(curl:*), Bash(git:*), Read, Edit, Write, Glob, Grep
---

# opice-reeval — diagnose & fix a failed run

A CI run went red. Your job: find out *why* each scenario failed, reproduce it
locally, and resolve it correctly — fix the test when the test is wrong, raise a
flag when the **app** is wrong. The whole value of this skill is that judgment;
do not destroy it by weakening assertions to force green.

## The one rule that matters

**Never make a failing test pass by removing or loosening the assertion that
caught the failure.** A red test is either:

- **test drift** — the app is fine, the test is stale (selector changed, timing,
  renamed label). → Fix the test.
- **a real regression** — the app is broken, the assertion did its job. → Do
  **not** touch the test. Report the regression with evidence (the step, the
  error, the screenshot) and stop.

When unsure which it is, treat it as a possible regression and ask. Silently
deleting an assertion is the worst outcome this skill can produce.

## Inputs

- A **failed-run URL** (paste from the dashboard, includes `?token=`), or a bare
  **run id** plus a configured endpoint/`OPICE_READ_TOKEN`.
- The repo checked out locally, with the playground runnable.

## Workflow

### 1. Pull the failure digest

```bash
opice failures "<run-url-or-id>"        # human-readable
opice failures "<run-url-or-id>" --json # if you want to parse it
```

This gives you, per failed scenario: the failing step, the error, an absolute
(tokened) screenshot URL, and the **source files** (`test_file`,
`scenario_file`) — so you don't have to grep. If `opice failures` can't reach
the platform or the token is missing, fall back to CI logs:

```bash
gh run view <run-id> --log-failed     # the raw bun assertion + stack
```

CI logs have the exact stack but no screenshots and no step framing — use the
platform digest as the primary source and CI logs to go deeper on a stack.

### 2. Look at the failure before touching anything

For each failed scenario, download the failure screenshot and read it — it
usually tells you instantly whether the UI is broken or just shaped differently:

```bash
curl -s "<screenshot-url-with-token>" -o /tmp/opice-fail-<n>.png
```

Read `/tmp/opice-fail-<n>.png` and the step error together. Open the
`test_file` and its `scenario_file`.

### 3. Reproduce locally

Make sure the playground is running. Then run just the failing test:

```bash
bun test <test_file>
```

- **Fails locally too** → reproducible. Go to step 4.
- **Passes locally** → not reproducible: flaky or environment-specific (timing,
  seed data, CI-only state). Don't "fix" code that passes — diagnose the
  divergence (race needing `waitFor`? data the scenario assumed?), propose the
  minimal robustness change, and say it was green locally.

### 4. Walk it live to find the cause

Reproduce the scenario in a real browser the same way `opice-author` does —
re-snapshot, follow the scenario's steps, and find where reality diverges:

```bash
opice-browser launch <URL>#<hash>
opice-browser aria-snapshot main      # the agent's view; re-run after each step
```

Classify the divergence:

- **Selector drift** (testid/label/role changed, element moved): update the
  selector/locator to a stable one (`el`/`byRole`/`byLabel`). Test fix. ✔
- **Timing** (assertion ran before async UI settled): replace fixed waits with a
  retrying `await expect(el(x)).toHaveText(...)` on a stable marker. Test fix. ✔
- **Scenario wrong** (the scenario described behaviour the app never had / no
  longer should have): the scenario is the bug — update the `*.scenario.md` and
  regenerate the step, and say so. ✔ (with the user's nod)
- **App regression** (the app should do X, it now does Y, the assertion is
  right): **stop fixing.** Report it — scenario, step, expected vs actual, the
  screenshot — as a regression. ✘ Do not edit the test.

### 5. Verify the fix

After any test/scenario edit, re-run until green *for the right reason* — the
assertion still asserts the original intent:

```bash
bun test <test_file>
```

If you changed selectors/timing, confirm the test still fails when the app
behaviour it checks is actually broken (don't over-relax).

### 6. Report

Per failed scenario, one line: `fixed (selector)`, `fixed (timing)`,
`scenario updated`, `flaky — green locally`, or **`REGRESSION — app bug, test
left red`**. Then a short summary grouping them. List exactly which files you
changed.

**Do not commit** unless the user asks. When they do, commit atomically with an
explicit file list (per the user's git rules), and never bundle a real
regression's test into a "fix" commit.

## Notes

- Multiple failed scenarios: handle them one at a time; they often share a root
  cause (one renamed testid breaks five tests).
- If many scenarios fail from one UI refactor, this is a re-author job — point
  the user at `opice-batch` to regenerate the suite, rather than hand-patching
  each test here.
- Re-eval reuses `opice-author`'s live-walking and selector-resolution
  procedure for the fix step — when in doubt about how to pick a selector, defer
  to that skill's preference order (`data-testid` first).
