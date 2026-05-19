# opice dashboard — design system

A CI/E2E reporting dashboard. An AI agent (the "opice", Czech for monkey) walks
through your app following human-readable scenarios, takes screenshots, and
files a report. This dashboard reads those reports back.

## Direction — "Field journal"

The conceit: opice is a primatologist's silent assistant in the field. Each run
is an *observation session*: scenario names are prose, steps are field notes,
screenshots are photographic evidence, stack traces are marginalia.

Not safari kitsch. Not banana emojis. The metaphor lives in the *typography*,
the *paper-like surfaces*, and the *editorial margin layout* — not in
illustration.

### What we are not

- Not the blue-black "dev dashboard" look (Vercel/Linear cold). Too generic.
- Not a Material/Bootstrap card grid. Too componenty.
- Not safari kitsch (no banana icons, no jungle gradients).

### Color world

Reference: a botanical herbarium plate. Sage-tinted paper, olive ink, deep
forest accent, lichen green for life signs, vermilion for warnings, ochre
amber only for the in-progress status (the one warm note that says "the
specimen is still moving"). The old cream-amber palette was too cocoa /
notebook — this is more "herbarium folio".

### Signatures (must remain visible in code)

1. **Marginalia layout.** Pages have a narrow left gutter (`--gutter`, ~80px on
   desktop). Status marks, sequence numbers, and timestamps live in the gutter.
   The main column carries the prose (project name, scenario name, screenshot,
   error). This is the single biggest departure from "dashboard table" defaults.

2. **Typographic status marks, not pills.** `●` lichen for pass, `✕` vermilion
   for fail, `◐` amber for running. They live in the gutter at the start of a
   row, sized at body height, never enclosed in shapes.

3. **Polaroid evidence.** Screenshots get a cream paper frame (8px on three
   sides, larger at the bottom) and a serif italic caption with the step name.
   The frame uses `--paper` regardless of surrounding surface — it carries the
   metaphor.

4. **Result strip, not stat cards.** A run summary is a single horizontal
   segmented bar (passed/failed/running proportions), not four equal cards.
   Number-on-card is a default. Reject it.

5. **Editorial scenario rule.** Between scenarios in a run, a thin sepia
   horizontal rule with a small ornament (✦) — same idea as section breaks in
   long-form text.

## Modes

Light mode is **primary** (the journal metaphor demands paper). Dark mode is
supported but warm cocoa — never the cool navy default.

Switch with `prefers-color-scheme`. No toggle in v1.

## Tokens

Critical: `--accent` (brand / links / focus / theme underline) is **separate**
from `--running` (status only). Earlier the same `--amber` was used for both,
which dragged the whole UI toward orange. Forest green now owns brand
language; ochre amber is reserved for the running state alone.

```css
/* Light — primary. Sage cream paper, olive ink. */
--paper:         #ecedde;
--paper-soft:    #dde0c8;
--paper-edge:    rgba(30, 50, 25, 0.16);
--paper-rule:    rgba(30, 50, 25, 0.22);
--paper-edge-soft: rgba(30, 50, 25, 0.08);

--ink:           #1c2317;
--ink-soft:      #38462e;
--ink-mute:      #6a785a;
--ink-faint:     #a6ad94;

--accent:        #3a6a30;   /* deep forest — interactive */
--accent-soft:   #cad8b5;

--lichen:        #5d8a30;   /* pass */
--lichen-soft:   #d4dfb2;
--vermilion:     #a8351a;   /* fail */
--vermilion-soft: #ecccbe;
--running:       #a47118;   /* ochre — only for running */
--running-soft:  #ecd594;

/* Dark — deep forest, not cocoa. */
--paper:         #131811;
--paper-soft:    #1c2218;
--paper-edge:    rgba(220, 235, 200, 0.14);
--paper-rule:    rgba(220, 235, 200, 0.18);
--paper-edge-soft: rgba(220, 235, 200, 0.06);

--ink:           #e8ecda;
--ink-soft:      #b6c0a2;
--ink-mute:      #7a8966;
--ink-faint:     #4e5a44;

--accent:        #9bbf7a;
--accent-soft:   #243018;

--lichen:        #b6d68a;
--lichen-soft:   #2c3a1d;
--vermilion:     #e07458;
--vermilion-soft: #3e1b12;
--running:       #d99c36;
--running-soft:  #3e2e10;
```

## Typography

- **Serif (display, proper nouns, scenario names):** Source Serif 4. Weights
  400/600. Tight tracking on large sizes.
- **Sans (UI, body, data):** Inter. 400/500/600.
- **Mono (commit hash, slug, code, error):** JetBrains Mono. 400/500.
- **Numbers** — `font-variant-numeric: tabular-nums` for any column-aligned
  number (durations, counts).
- Caption style: small-caps `tracking-wider`, `--ink-mute`, used for column
  labels and gutter timestamps.

```css
--font-serif: 'Source Serif 4', 'Source Serif Pro', 'Iowan Old Style', Georgia, serif;
--font-sans:  'Inter', system-ui, sans-serif;
--font-mono:  'JetBrains Mono', ui-monospace, Menlo, monospace;
```

## Spacing

Base **8px**. Scale: 4, 8, 12, 16, 24, 32, 48, 64. Major page sections use 32 or
48. Section rules add 24 above + below. Gutter `--gutter: 80px` on desktop,
collapses to 48px on mobile (status mark stays, timestamp wraps below name).

## Depth

**Borders-only.** No shadows anywhere — including modals (we don't have any).
Borders use rgba so they sit on either paper tone without harshness. One
elevation level above paper: `--paper-soft` for inputs, code chips, hover
surfaces, *and the bordered section cards* (see below).

### Section cards (used sparingly)

A handful of sections are wrapped in a bordered card filled with
`--paper-soft`. This is for grouping a logically-related block, not for
visual padding. Used for:

- **Result strip** on the run page — the session summary reads as one unit.
- **Entry list** on registry / project detail — the run / project rows sit
  inside a single surface rather than floating against the page paper.

Rules of the card:

- Border: `1px solid var(--paper-edge)`, `border-radius: 4px`.
- Background: `var(--paper-soft)`.
- Spans the full content width including the gutter (`grid-column: 1 / -1`),
  so the inner marginalia belongs to the card, not the page.
- On `.entry` hover the row brightens to `var(--paper)` (lifts off the
  soft surface) rather than darkening.

Do not stack cards. Scenarios are kept airy; boxing each one would feel
cramped. Page-head and section-head remain card-less.

## Radii

- 0 — page edges, gutter rules
- 2px — code chips, inline mono
- 4px — small inputs, buttons
- 6px — polaroid frame, larger code blocks
- *no large radii.* Cards are sharp-cornered like a notebook page.

## Components / patterns

### Status mark

```tsx
<StatusMark status="passed" />   // ●  lichen
<StatusMark status="failed" />   // ✕  vermilion
<StatusMark status="running" />  // ◐  amber, slow pulse
```

Always rendered at body line-height. Never inside a pill background.

### Result strip

Horizontal segmented bar (height 6px). Three segments: passed (lichen), failed
(vermilion), running (amber). Below the bar: a serif title for the run and a
sans subtitle with "N passed · M failed · duration". No four-card metric grid.

### Entry row

For tables of runs/projects: a row with status mark in the gutter, name in
serif as the primary lead, secondary metadata in small-caps sans. Border-bottom
sepia rule. Hover: paper-soft background only.

### Polaroid

```tsx
<Polaroid src={url} caption="user clicks login" />
```

Cream paper frame; serif italic caption beneath; click opens full-size in new
tab. Uses `--paper` (light) or `--paper-soft` (dark) so it pops against any
surrounding surface.

### Section rule

```html
<hr class="rule" data-ornament="✦">
```

Sepia hairline, centered ornament, 24/24 vertical breathing.

## Things to avoid

- Pill badges for status
- Equal-size stat cards
- Box shadows of any kind
- Cool blue links — use amber
- Pure black or pure white
- Rounded corners > 6px
- Emojis used as functional UI (the brand monkey is OK in the header only)

## Layout

```
┌─────────────────────────────────────────────┐
│  HEADER       opice · brand                  │
├─────────────────────────────────────────────┤
│  GUTTER  │  CONTENT                          │
│  80px    │  serif heading                    │
│          │  small-caps caption               │
│  ●  12m  │  Scenario name in serif           │
│      ago │  body sans, polaroid evidence     │
│  ✕   3m  │                                   │
│      ago │  ─── ✦ ───                        │
│          │  next scenario                    │
└─────────────────────────────────────────────┘
```

Max content width: 880px (narrower than usual dashboards on purpose — reads
like prose). Gutter + content combined: ~960px.

### Heading & breadcrumb alignment

Page-head (eyebrow + h1 + subtitle), breadcrumb, and section-head all span
`grid-column: 1 / -1` with `padding-left: 0`. They align with the **logo's
left edge** in the header — not with the content column. Only entry rows,
scenarios, and other gutter-bearing content sit inside the marginalia grid.
This keeps the page hierarchy reading as one column when scanning the left
margin top-to-bottom: logo → breadcrumb → h1 → section labels, then the
gutter activates only where there's something to mark.
