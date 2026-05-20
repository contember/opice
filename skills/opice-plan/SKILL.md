---
name: opice-plan
description: >
  Turn a rough testing brief into a set of human-readable `*.scenario.md`
  files for opice. Lightly explores the running app to ground scenarios in the
  real UI, then writes one scenario file per coherent user flow. Does NOT author
  tests (that's opice-author) — it produces the scenarios a human reviews first.

  Trigger when the user says "/opice-plan", "plan opice scenarios for …",
  "what should we E2E test here", or hands you a feature/app and asks for test
  scenarios.
allowed-tools: Bash(agent-browser:*), Read, Write, Glob, Grep
---

# opice-plan — brief → scenarios

This skill is the **meta-authoring** layer that sits above `opice-author`. You
take a loose brief ("test the checkout flow", "cover the admin dashboard") plus
the running app, and you produce a reviewable set of `*.scenario.md` files. You
do **not** write `*.test.ts` — that's `opice-author`'s job, run per scenario.

Keep the human in the loop: scenarios are cheap to read and correct, tests are
not. Aim for scenarios a reviewer can confirm at a glance.

## Inputs

- **brief**: what the user wants covered (a sentence, a feature, a page).
- **app URL**: the running playground/app. If not given, check `PLAYGROUND_URL`,
  then ask.
- **output dir**: where the `*.scenario.md` files go. Default: a `scenarios/` or
  `tests/browser/` dir next to the app, mirroring any existing scenario files.
  Confirm before writing into a new location.

## Workflow

### 1. Understand what already exists

- Glob for existing `*.scenario.md` to match naming, structure, and granularity.
- Read the brief. List the distinct user flows / features it implies.

### 2. Lightly explore the app (don't author)

Use a throwaway session:

```bash
agent-browser --session opice-plan-$$ open <URL>
agent-browser --session opice-plan-$$ snapshot -i
```

Walk the surface enough to ground scenarios in reality — what pages, controls,
roles, and states actually exist. You're mapping the territory, **not** resolving
selectors or proving steps. Visit the main routes/hashes the brief touches.
Note where `data-testid`s exist (good) or are missing (flag it).

Stay lightweight: a few snapshots across the relevant screens, not an
exhaustive crawl. If the app needs auth or seeded data to reach a flow, note it
as a prerequisite rather than trying to set it up.

### 3. Draft one scenario file per flow

For each coherent user flow, write a `*.scenario.md` using
`scenario-template.md` (in the opice-author skill). Good scenarios:

- **One flow each** — a scenario is a single coherent walkthrough, not a grab
  bag. Split "login" and "checkout" into separate files.
- **Plain-English numbered steps** mixing actions and assertions, each step =
  one future `step()`.
- **Concrete and observable** — "the cart shows 2 items" beats "the cart works".
- **Grounded** in what you actually saw: real labels, real routes, real states.
- **Honest about prerequisites** in the Context section (logged in? seeded?
  feature flag?). opice-author won't set these up.
- **Flagging brittleness** in Notes (missing testids, async data, dialogs).

Name files after the flow: `checkout.scenario.md`, `admin-users.scenario.md`.

### 4. Summarize and hand off

Print:

- the list of scenario files written, one line each with its title;
- any flows you deliberately skipped and why (needs auth, out of scope, etc.);
- where `data-testid`s are missing, so the user can add them before authoring.

Then tell the user: review the scenarios, then run `opice-author` per file (or
the `opice-batch` skill to author them all). **Do not author or commit** unless
the user asks.

## Notes

- When in doubt about scope, propose the scenario list *first* (titles + one
  line each) and let the user prune before you write all the files.
- Prefer more, smaller scenarios over a few sprawling ones — they fail more
  legibly and re-eval is easier per scenario.
