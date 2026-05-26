---
name: opice-plan
description: >
  Phase 1 of opice authoring: turn a rough testing brief into reviewable
  *skeleton* `*.test.ts` files — metadata-first `browserTest`, pending `step`
  stubs carrying `intent` + `hint`, and `invariant.todo` acceptances. Lightly
  explores the running app to ground the skeletons in the real UI. Does NOT
  author executable steps (that's opice-author, phase 2) — it produces the
  skeleton a human reviews first.

  Trigger when the user says "/opice-plan", "plan opice scenarios for …",
  "what should we E2E test here", or hands you a feature/app and asks for test
  scenarios.
allowed-tools: Bash(opice-browser:*), Bash(bun:*), Read, Write, Glob, Grep
---

# opice-plan — brief → skeleton tests (phase 1)

This skill is the **planning** half of opice authoring. You take a loose brief
("test the checkout flow", "cover the admin dashboard") plus the running app,
and you produce reviewable **skeleton `*.test.ts` files**. You do **not** write
executable steps — that's `opice-author` (phase 2), run per skeleton.

## Why a skeleton `.test.ts`, not a `.scenario.md`

opice used to plan into a separate `*.scenario.md` and author into a sibling
`*.test.ts`. Two artifacts describing the same flow **drift**: someone edits the
test, the prose goes stale, and a reader is misled about what the test actually
does. So planning and authoring now share **one file**. Phase 1 writes a real
`*.test.ts` that type-checks and runs — but every step is a *pending stub* with
no body. Phase 2 fills the bodies in place. The spec never lives anywhere the
test can diverge from.

Keep the human in the loop: skeletons are cheap to read and correct, authored
tests are not. Aim for a skeleton a reviewer can confirm at a glance.

## Inputs

- **brief**: what the user wants covered (a sentence, a feature, a page).
- **app URL**: the running playground/app. If not given, check `PLAYGROUND_URL`,
  then ask.
- **output dir**: where the skeleton `*.test.ts` files go. Default: a
  `tests/browser/` dir next to the app, mirroring any existing test files.
  Confirm before writing into a new location.

## Workflow

### 1. Understand what already exists

- Glob for existing `*.test.ts` (and any leftover `*.scenario.md`) to match
  naming, structure, and granularity.
- Read the brief. List the distinct user flows / features it implies.

### 2. Lightly explore the app (don't author)

Use a throwaway session:

```bash
opice-browser --session opice-plan launch <URL>
opice-browser --session opice-plan aria-snapshot main
```

Walk the surface enough to ground the skeleton in reality — what pages,
controls, roles, and states actually exist. You're mapping the territory,
**not** resolving selectors or proving steps (that's phase 2). Visit the main
routes/hashes the brief touches. Note where `data-testid`s exist (good) or are
missing (flag it). Run `opice-browser --session opice-plan quit` when done.

Stay lightweight: a few snapshots across the relevant screens, not an
exhaustive crawl. If the app needs auth or seeded data to reach a flow, note it
in the metadata (`seeds`, `roles`) rather than trying to set it up.

### 3. Write one skeleton `*.test.ts` per flow

For each coherent user flow, write a skeleton using `skeleton-template.ts` (in
the opice-author skill). The shape:

```ts
import { test } from 'bun:test'
import { browserTest, invariant, step } from '@opice/harness'

browserTest(
	{
		name: 'Checkout — pay with a saved card',
		url: 'http://localhost:5173/cart',
		feature: 'F-CHK-02',
		seeds: ['catalog', 'saved-card'],
		roles: ['shopper'],
	},
	() => {
		test('walkthrough', async () => {
			await step('cart shows the seeded item and a Pay button', {
				intent: 'a non-empty cart can proceed to payment',
				hint: 'assert the item name is visible and the Pay button is enabled',
			})

			await step('pay with the saved card', {
				intent: 'paying with a saved card completes the order without re-entering details',
				hint: 'click Pay; expect an order-confirmation heading + an order number',
			})

			await invariant.todo(
				'the card PAN is never rendered in full — only the last 4 digits',
				'after payment, assert the page text never contains the full seeded PAN',
			)
		}, 60_000)
	},
)
```

What goes where — the rule is **does anything other than a human read it?**

- **Metadata (first arg of `browserTest`)** — machine-relevant context:
  - `name` — the scenario title.
  - `url` — **deep-link** to the deepest stable route the flow lives on
    (`/cart`, `/app/programs/create`). Auth is a *precondition*, not a step: if
    the app authenticates ambiently (dev token / injected state), deep-linking
    lands authenticated. Reserve `/` for the one login/logout scenario that's
    actually *about* the auth transition.
  - `feature` — the requirement id this covers, if any (dashboard grouping).
  - `seeds` — the idempotent, composable seeds this flow needs. Name them; don't
    set them up.
  - `roles` — the identities the flow acts as.
- **`step(name, { intent, hint })`** — one pending stub per future step:
  - `name` — a concrete, **observable** outcome ("the cart shows 2 items" beats
    "the cart works").
  - `intent` — the durable *why* / what it proves. This survives verbatim into
    the authored test, so write it as the spec, not as a restatement of the UI.
  - `hint` — instructions to `opice-author`: what to actually do on the page. It
    is dropped once the step is authored, so be concrete and disposable here.
- **`step.blocked(name, reason, { intent })`** — a step the app **can't support
  yet** because the feature isn't built. Use it (instead of a plain stub) when
  you found, while exploring, that a flow the brief asks for simply doesn't
  exist in the UI. The `reason` says what's missing. A plain `step(...)` stub
  means "feature exists, test not written yet"; `step.blocked` means "feature
  not built yet" — the dashboard shows them apart (grey pending vs amber
  blocked) so a reviewer sees at a glance which scenarios are waiting on the app
  vs. waiting on authoring.
- **`invariant.todo(name, hint)`** — a scenario-level acceptance that must always
  hold, independent of the steps (the kind of thing that used to live in a
  scenario's "Notes"). Phase 2 promotes it to an enforced `invariant(...)`. Use
  **`invariant.blocked(name, reason)`** when the property can't be enforced yet
  because the feature guarding it isn't built.

Good skeletons:

- **One flow each** — a skeleton is a single coherent walkthrough, not a grab
  bag. Split "login" and "checkout" into separate files.
- **Concrete and observable** step names; grounded in real labels/routes/states
  you actually saw.
- **Assume a shared, never-reset DB.** opice runs leave data behind (seeds +
  rows from past runs). Steps must tolerate arbitrary pre-existing data: assert
  the **presence of a uniquely-identified thing**, never counts, emptiness, or
  "the only one". A flow that *creates* data should say (in the `hint`) to stamp
  it with a unique per-run marker (e.g. a `Date.now()` suffix) and assert on
  that. "Empty state" / exact-count flows can't run against the shared DB — flag
  them as needing a throwaway instance instead of writing them here.

Name files after the flow: `checkout.test.ts`, `admin-users.test.ts`.

### 3a. Sanity-check the skeleton runs

A skeleton is a real test file — make sure it type-checks and runs (all steps
report pending, the run passes with a "N pending step(s)" warning):

```bash
bun test <skeleton>.test.ts
```

If it errors (bad import, malformed metadata), fix it before handing off. Do
**not** add step bodies — that's phase 2.

### 3b. Maintain the suite's context/invariants file

App-wide truths that hold for *every* scenario don't belong copy-pasted into
each skeleton's metadata. Keep them in one `invariants.md` (or
`<suite>.context.md`) next to the tests, and have each skeleton lean on it.
Capture: base URL(s) + auth model (how a test arrives authenticated), selector
strategy (do `data-testid`s exist? else role/label), first-load timeout quirks,
known overlays/dialogs that intercept clicks, the shared-DB assertion rules
above, and the catalog of available seeds (name → what it guarantees + the
stable ids it uses). opice-author reads this before authoring, so it's the right
home for everything that would otherwise be repeated boilerplate.

### 4. Summarize and hand off

Print:

- the list of skeleton files written, one line each with its title;
- any flows you deliberately skipped and why (needs auth, out of scope, etc.);
- where `data-testid`s are missing, so the user can add them before authoring.

Then tell the user: review the skeletons (intent + invariants especially), then
run `opice-author` per file (or the `opice-batch` skill to author them all).
**Do not author or commit** unless the user asks.

## Notes

- When in doubt about scope, propose the skeleton list *first* (titles + one
  line each) and let the user prune before you write all the files.
- Prefer more, smaller scenarios over a few sprawling ones — they fail more
  legibly and re-eval is easier per scenario.
- Write `intent` and `invariant.todo` carefully: they are the part of the
  skeleton that *survives* into the final test and that re-eval trusts as the
  independent statement of what should be true. The `hint`s are throwaway.
