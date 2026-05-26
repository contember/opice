# opice-author Claude Code skill

Phase 2 of opice authoring: fills in a phase-1 skeleton `*.test.ts` (written by
`opice-plan`) — turning pending `step` stubs into executable `@opice/harness`
steps with real selectors — by driving the app in a real browser.

## Install

From the repo root:

```bash
bun run skills:install          # symlinks all opice skills into ~/.claude/skills/
bun run skills:install --copy   # copies instead, if you don't want a live link
bun run skills:uninstall        # removes them
```

Then restart Claude Code so it picks up the skill.

## Use

In Claude Code:

```
/opice-author tests/browser/login.test.ts
```

Or just hand Claude a skeleton `.test.ts` (pending steps) and ask for a test.

See [`SKILL.md`](./SKILL.md) for the full workflow.
