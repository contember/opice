---
name: opice-plan
description: >
  Phase 1 of opice authoring: turn a rough testing brief (and/or supplied
  scenarios, a spec, or just the codebase) into reviewable *skeleton*
  `*.test.ts` files — metadata-first `browserTest`, pending `step` stubs
  carrying `intent` + `hint`, and `invariant.todo` acceptances. Grounds the
  skeletons in real flows using whatever's available — supplied docs, code
  exploration, and/or a light browse of the running app. Does NOT author
  executable steps (that's opice-author, phase 2) — it produces the skeleton a
  human reviews first.

  Trigger when the user says "/opice-plan", "plan opice scenarios for …",
  "what should we E2E test here", hands you a feature/app/spec, or gives you
  rough scenarios to turn into tests.
allowed-tools: Bash(opice-browser:*), Bash(bun:*), Read, Write, Glob, Grep
---

# opice-plan — brief → skeleton tests (phase 1)

This skill is the **planning** half of opice authoring. You take a loose brief
("test the checkout flow", "cover the admin dashboard") — and/or supplied
scenarios, a spec, or just the codebase — and you produce reviewable **skeleton
`*.test.ts` files**. You do **not** write executable steps — that's
`opice-author` (phase 2), run per skeleton.

You only need enough grounding to get the *structure* right: the flows, the
step outline, the metadata (`feature`/`seeds`/`roles`), the `intent`, and a
`hint` per step telling the author what to do live. The precise selectors and
the real rendered labels are `opice-author`'s job in phase 2 — so planning can
stay light and does **not** require a running app.

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

- **brief**: what the user wants covered (a sentence, a feature, a page). May be
  thin if other inputs are rich.
- **supplied material** (optional, any of): rough scenarios the user already
  wrote, a PRD / spec / acceptance criteria, a list of flows, a Figma, a ticket.
  When given, this is your *primary* source — turn it into skeletons rather than
  re-deriving the flows yourself.
- **app URL** (optional): the running app. Only needed if you choose to confirm
  things live (see grounding below). If not given, check `PLAYGROUND_URL`; don't
  block on it — code/docs may be enough.
- **output dir**: where the skeleton `*.test.ts` files go. Default: a
  `tests/browser/` dir next to the app, mirroring any existing test files.
  Confirm before writing into a new location.

## Workflow

### 1. Understand what already exists

- Glob for existing `*.test.ts` (and any leftover `*.scenario.md`) to match
  naming, structure, and granularity.
- Read the brief. List the distinct user flows / features it implies.

### 2. Ground the scenarios — pick the source(s) that fit

You need enough grounding to get the flows, step outline, and metadata right —
**not** real selectors or proven steps (that's phase 2). Use whichever of these
is available; combine them. None is mandatory, and a running app is **not**
required.

**a) Supplied scenarios / spec (if given).** This is the strongest signal — the
user already told you the flows. Map each supplied scenario/acceptance criterion
to a skeleton, lift the structure and intent straight from it, and only fill
gaps (metadata, missing edge steps) from code/app. Don't second-guess flows
the user handed you.

**b) Explore the codebase (no running app needed).** Often the fastest, fullest
source — and it works offline:
- Routes / pages → the deep-link `url` per scenario (route files, the router,
  `*.page.tsx`, etc.).
- Components / JSX → existing `data-testid`s (great), accessible labels, headings
  → grounds step names and what's assertable; flag where test-ids are missing.
- ACL / auth / roles → the `roles` metadata and which identity a flow acts as.
- Seed definitions / fixtures → the `seeds` metadata (name → what it guarantees).
- Feature/requirement ids in code or docs → the `feature` metadata.
Use Glob/Grep/Read. This alone is usually enough to write solid skeletons.

**c) Light browse of the running app (optional).** Only when the app is up and
you want to confirm real labels/states or you can't tell the flow from code. A
throwaway session:

```bash
opice-browser --session opice-plan launch <URL>
opice-browser --session opice-plan aria-snapshot main
```

Stay lightweight — a few snapshots across the relevant screens, never an
exhaustive crawl, never resolving selectors. `opice-browser --session opice-plan
quit` when done.

Whatever you couldn't pin down here, **defer to phase 2 via the step `hint`**
("confirm the exact button label live", "verify this field is a custom picker") —
that's exactly what hints are for. If a flow needs auth/seeded data to reach,
record it in `seeds`/`roles`, don't set it up.

### 3. Write one skeleton `*.test.ts` per flow

For each coherent user flow, write a skeleton using `skeleton-template.ts` (in
the opice-author skill). The shape:

```ts
import { browserTest, invariant, step } from '@opice/harness'

browserTest(
	{
		name: 'Checkout — pay with a saved card',
		url: 'http://localhost:5173/cart',
		feature: 'F-CHK-02',
		seeds: ['catalog', 'saved-card'],
		roles: ['shopper'],
		// retries: 2,  // optional: re-run flaky scenarios, fresh browser per attempt
	},
	async () => {
		await step('cart shows the seeded item and a Pay button', {
			intent: 'a non-empty cart can proceed to payment',
			hint: 'assert the item name is visible and the Pay button is enabled',
			manual: 'V košíku uvidíte vloženou položku a tlačítko „Zaplatit". Zkontrolujte, že tam obojí opravdu je.',
		})

		await step('pay with the saved card', {
			intent: 'paying with a saved card completes the order without re-entering details',
			hint: 'click Pay; expect an order-confirmation heading + an order number',
			manual: 'Klikněte na tlačítko „Zaplatit". Platba proběhne uloženou kartou — nic dalšího vyplňovat nemusíte. Poté se zobrazí potvrzení objednávky s jejím číslem.',
		})

		await invariant.todo(
			'the card PAN is never rendered in full — only the last 4 digits',
			'after payment, assert the page text never contains the full seeded PAN',
		)
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
  - `manual` — a plain-language line for the **end user**, the human-readable
    "what you do / what you should see" for this step. Where `intent` is the
    machine-facing spec, `manual` is the instruction-manual sentence a
    **non-technical** reader could follow. Durable like `intent` (it survives
    into phase 2). Write it:
    - **In the manual's target language — typically Czech** (match the app's UI
      language and any existing manuals in the suite; only use another language
      if that's what the manuals are written in).
    - **In the formal register** (Czech: *vykání* — "Klikněte…", "Vyplňte…",
      "Ověřte, že vidíte…"), never the informal *tykání*.
    - **Stupid simple (MISS — Make It Stupid Simple).** Assume the reader knows
      nothing technical: no jargon, no role/seed/route names, no selectors.
      Refer to what's on screen by its **visible label in quotes** („Zaplatit"),
      use plain verbs, one action per sentence. If a label isn't pinned down
      yet, write your best guess and let phase 2 correct it.
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
- Write `intent`, `manual`, and `invariant.todo` carefully: they are the part
  of the skeleton that *survives* into the final test — `intent`/`invariant.todo`
  as the independent statement re-eval trusts, `manual` as the end-user-facing
  description. The `hint`s are throwaway.
- Give every executable-by-phase-2 `step` a `manual` line. A `step.blocked`
  (feature not built) doesn't need one yet — there's nothing for a user to do.
