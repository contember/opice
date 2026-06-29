# opice → Remotion tutorial template

Turns an **opice recording + its step manifest** into a polished tutorial video:
an intro card, **per-step captions**, and **zoom-to-cursor** on each action — then
a closing card.

This is a **post-production** layer, deliberately kept *outside* the opice
workspace so the (heavyweight, separately-licensed) Remotion dependency stays
opt-in. opice captures; Remotion produces.

## The pipeline

```
opice (capture)                              Remotion (this template)
  OPICE_VIDEO=1 bun test …                     reads public/<name>.{webm,json}
   → <name>.webm   (screencast + cursor)  ──►   • intro title from manifest.scenario
   → <name>.json   (step manifest)              • caption per step (name + timecode)
                                                 • zoom toward each step's cursor anchor
                                                 • outro
                                                → out/tutorial.mp4
```

The manifest is what makes this work without re-driving the app — opice emits it
next to every recording:

```jsonc
{
  "scenario": "Create a site",
  "video": "create-a-site.webm",
  "size": { "width": 1280, "height": 720 },
  "steps": [
    { "name": "Sign up with your email", "tStartMs": 472, "durationMs": 956,
      "status": "passed", "cursor": { "x": 640, "y": 438 } }
  ]
}
```

`step.name` → caption text; `tStartMs`/`durationMs` → caption timing; `cursor` →
the point the camera zooms toward.

## Use it

1. **Record** a green walkthrough with opice, pointing the output at `public/`:

   ```bash
   OPICE_VIDEO=1 OPICE_VIDEO_DIR="$PWD/examples/remotion-tutorial/public" \
   OPICE_VIDEO_SIZE=1280x720 OPICE_VIDEO_SLOWMO=140 \
     bun test path/to/your-scenario.test.ts
   ```

   (`OPICE_VIDEO_SLOWMO` paces the run so the synthetic cursor glides before each
   click; `OPICE_VIDEO_CURSOR=0` turns the cursor off.)

2. **Preview** in Remotion Studio:

   ```bash
   cd examples/remotion-tutorial
   bun install
   bun run studio
   ```

3. **Render** to MP4 (pass the recording's base name via props if it isn't the
   default `create-a-site`):

   ```bash
   bunx remotion render Tutorial out/tutorial.mp4 --props='{"base":"<name>"}'
   ```

## Tuning

- Intro/outro length, fps, zoom amount: `src/Root.tsx` (`INTRO_SECONDS`,
  `OUTRO_SECONDS`, `FPS`) and `src/Tutorial.tsx` (`focusAt`'s `0.16` zoom factor).
- Caption look: the `Caption` component in `src/Tutorial.tsx`.

## Licensing

Remotion is free for individuals and small companies but requires a paid company
license above a threshold — see <https://remotion.dev/license>. That's the main
reason this template is a standalone, opt-in package rather than part of
`@opice/harness`.
