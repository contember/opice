# Opice

AI-driven E2E browser test harness. Human-readable scenarios → LLM-generated tests → deterministic CI runs → centralized reporting.

> Status: **early WIP**. v1 scope below.

## What it is

A monkey-testing harness (hence "opice") for web apps:

1. You write a human-readable scenario in markdown (`login.scenario.md`)
2. The `opice-author` Claude Code skill walks the running app via [`agent-browser`](https://github.com/.../agent-browser), generates a `*.test.ts` file with `data-testid` selectors, verifies it passes, commits
3. CI runs the generated tests deterministically (no LLM in the loop), streaming results + screenshots to the central reporting platform
4. On failure, `opice-fix` skill diagnoses from screenshots and proposes an edit

## Architecture (v1)

- **Tests live in your repo.** Reviewed in PRs, atomic with UI changes, debuggable locally.
- **Browser runs in CI** (or locally), driven by `agent-browser` CLI. No remote browser farm.
- **Reporting platform on Cloudflare**: Worker (API + dashboard), D1 (run metadata), R2 (screenshots).
- **AI authoring is local** — Claude Code skill on your machine. No server-side LLM in v1.

## Repo layout

```
opice/
├── packages/
│   ├── harness/    # @opice/harness — runtime: el(), tid(), waitFor(), scenario(), step()
│   ├── worker/     # CF Worker — reporting API + dashboard (planned)
│   ├── cli/        # opice CLI — init, test wrapper (planned)
│   └── dashboard/  # SPA served by worker (planned)
└── apps/
    └── example/    # smoke-test app (planned)
```

## v1 roadmap

- [x] Week 1: `@opice/harness` extracted from bindx prototype
- [ ] Week 2: CF Worker + D1 + R2 + MVP dashboard
- [ ] Week 3: `opice-author` Claude skill (PoC)
- [ ] Week 4: GH Action, dogfood on bindx

## Non-goals (v1)

- Visual regression (screenshots are evidence, not asserts)
- Multi-tenant SaaS (single-user, single-org)
- AI in CI loop (authoring is local only)
- Browser farm in platform (you run your own browser)

## License

MIT
