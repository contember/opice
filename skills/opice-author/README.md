# opice-author Claude Code skill

Authors an `@opice/harness` E2E test from a human-readable scenario file.

## Install

```bash
ln -s "$(realpath skills/opice-author)" ~/.claude/skills/opice-author
```

(Or copy the directory if you don't want a live link.)

## Use

In Claude Code:

```
/opice-author tests/login.scenario.md
```

Or just hand Claude a `.scenario.md` and ask for a test.

See [`SKILL.md`](./SKILL.md) for the full workflow.
