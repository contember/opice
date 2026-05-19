# opice-author Claude Code skill

Authors an `@opice/harness` E2E test from a human-readable scenario file.

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
/opice-author tests/login.scenario.md
```

Or just hand Claude a `.scenario.md` and ask for a test.

See [`SKILL.md`](./SKILL.md) for the full workflow.
