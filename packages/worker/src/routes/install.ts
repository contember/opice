/**
 * `GET /install.md` — the onboarding guide a user pastes into Claude Code as
 * "Fetch instructions from <origin>/install.md". It's written *to* the agent
 * running inside the user's project repo: it walks the kickoff (deps, config,
 * skills, CI secret, first scenario). Served as plain markdown.
 *
 * The platform origin is injected so links/commands point at this deployment.
 */
import type { Services } from '../services'

export function handleInstallMd(request: Request, _services: Services): Response {
	const origin = new URL(request.url).origin
	return new Response(renderInstallMd(origin), {
		headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-cache' },
	})
}

function renderInstallMd(origin: string): string {
	return `# Opice integration — kickoff (for Claude Code)

You are running inside a user's project repository. Your job is to wire up
**opice** — an AI-driven E2E browser test harness that streams results to a
central dashboard at \`${origin}\`. Work *with* the user, and **confirm before
any outward or destructive step** (pushing secrets, committing, force-anything).

Read this whole guide first, then do the steps in order. Stop and ask if a
step's assumption doesn't hold.

---

## 0. Find the DSN

The user just created a project in the opice dashboard and was told to save an
\`OPICE_DSN\` into their local \`.env\`. Confirm it's there:

\`\`\`
OPICE_DSN=https://<apiKey>@<host>/<slug>
\`\`\`

If \`.env\` has no \`OPICE_DSN\`, ask the user to paste it. Parse it:
- **apiKey** = the userinfo (before \`@\`) — secret, treat as a credential
- **host** = the endpoint (\`https://<host>\`) — should be \`${origin}\`
- **slug** = the first path segment — the project id

Also confirm \`.env\` is gitignored. If not, add it before doing anything else.

---

## 1. Add the opice dependencies

Two packages:
- **\`@opice/harness\`** — the generated tests import from it
  (\`import { browserTest, el, tid, step } from '@opice/harness'\`).
- **\`@opice/cli\`** — the \`opice\` command (\`init\`, \`install-skills\`, \`test\`)
  that the local flow and the CI workflow run.

Add both as dev dependencies with the project's package manager:

\`\`\`bash
bun add -d @opice/harness @opice/cli    # or: npm i -D / pnpm add -D
\`\`\`

After that the CLI runs via \`bunx opice …\` (or \`npx\`/\`pnpm exec\`).

---

## 2. Scaffold config + CI workflow

\`\`\`bash
bunx opice init --project=<slug> --endpoint=<host> --with-workflow
\`\`\`

This writes \`opice.config.json\` and \`.github/workflows/opice.yml\`. Open the
workflow and adjust it to *this* project: the dev-server start command, the
port / \`PLAYGROUND_URL\`, and the test path. The workflow expects an
\`OPICE_DSN\` repo secret (step 4).

---

## 3. Install the opice skills + agent — into this repo

\`\`\`bash
bunx opice install-skills
\`\`\`

This writes \`opice-author\`, \`opice-plan\`, \`opice-batch\`, \`opice-reeval\` and the
author agent into **this project's** \`.claude/skills\` and \`.claude/agents\` —
always project-local, so they live in the repo. Make sure \`.claude/skills\` and
\`.claude/agents\` are **not** gitignored, and commit them in step 5 so the whole
team gets them. Tell the user to **restart Claude Code** so they load.

---

## 4. Push the CI secret  ⚠️ confirm first

The workflow needs the DSN as a repo secret. With the user's OK:

\`\`\`bash
gh secret set OPICE_DSN --body "<the OPICE_DSN value from .env>"
\`\`\`

(If the repo uses GitHub Environments, scope it accordingly.) Never echo the
secret into logs or commits.

---

## 5. Kickoff — the first scenario

1. Get the app running locally (find the dev command; note the URL/port).
2. Use the **opice-plan** skill to draft one \`*.scenario.md\` for a core flow
   (e.g. login, or the main happy path). Review it with the user.
3. Use **opice-author** to generate the \`*.test.ts\` from that scenario; it
   walks the live app and verifies the test passes.
4. Run it through the reporter:
   \`\`\`bash
   bunx opice test tests/browser/<your>.test.ts
   \`\`\`
   Open the run URL it prints and confirm the run shows up at \`${origin}\`.
5. Commit the scenario, test, \`opice.config.json\`, the workflow, and the
   installed \`.claude/\` extensions — atomically, with the user's review.

---

## Notes

- **DSN model:** \`OPICE_DSN\` is the one value to set (locally + CI). Individual
  \`OPICE_*\` vars override it if present.
- **Auth/roles:** the dashboard is email+password; everyone who logs in is an
  admin. Shareable read-only links use \`?token=…\`.
- Done well, the loop is: write a scenario → author a test → CI runs it
  deterministically → results land in the dashboard.
`
}
