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

Reference: aged paper, sepia ink, mahogany shadow, brass instrument, banana
amber afternoon light through canopy, lichen green, vermilion.

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

```css
/* Light — primary */
--paper:         #f5efe2;   /* page background, warm cream */
--paper-soft:    #ecdfc8;   /* sunk surface (input, code chip) */
--paper-edge:    #e3d2b3;   /* card border */
--paper-rule:    #d9c39e;   /* section rule */

--ink:           #221b15;   /* primary text */
--ink-soft:      #4b3b2a;   /* secondary text */
--ink-mute:      #8a7559;   /* tertiary, captions, metadata */
--ink-faint:     #b9a784;   /* disabled, faint marks */

--amber:         #b8741c;   /* accent — running, links */
--amber-soft:    #f0d99a;
--lichen:        #5d7a3c;   /* pass */
--lichen-soft:   #cfd9b3;
--vermilion:     #b53a1c;   /* fail */
--vermilion-soft: #e8c3b4;

/* Dark — warm cocoa, not black */
--paper:         #1a1310;
--paper-soft:    #241a15;
--paper-edge:    #3a2a1f;
--paper-rule:    #4a3526;

--ink:           #f0e6d2;
--ink-soft:      #cbb798;
--ink-mute:      #8e7959;
--ink-faint:     #5d4d38;

--amber:         #e8a93a;
--amber-soft:    #4a3414;
--lichen:        #9fb872;
--lichen-soft:   #2c3a1d;
--vermilion:     #e8745a;
--vermilion-soft: #3e1b12;
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
surfaces.

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
