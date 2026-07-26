import { execFileSync } from 'node:child_process'

/**
 * Best-effort git metadata for the current working tree. Returns the values
 * configured in opice runs (branch, commit). Falls back to env vars commonly
 * set by CI (GITHUB_REF_NAME, GITHUB_SHA) when not in a git checkout.
 */
export function detectGitMeta(): { branch?: string; commit?: string; commitTime?: string; commitDepth?: string } {
	const fromEnv = {
		branch: process.env['OPICE_BRANCH'] ?? ciBranch(),
		commit: process.env['OPICE_COMMIT'] ?? process.env['GITHUB_SHA'],
		commitTime: process.env['OPICE_COMMIT_TIME'],
		commitDepth: process.env['OPICE_COMMIT_DEPTH'],
	}
	// The commit TIME is what orders the change-tracking index: re-running an old
	// workflow gives it a fresh start time but not a fresh commit, and without
	// this the rerun would outrank a newer commit and restore stale edges.
	try {
		// `--abbrev-ref` answers the literal string `HEAD` in a detached checkout,
		// which is not a branch name. Reporting it as one is worse than reporting
		// nothing: `isDefaultBranch` rejects it, so the footprint index never fills
		// and `--impacted` stays useless with no visible cause.
		const branch = fromEnv.branch ?? nonEmptyBranch(runScalar(['rev-parse', '--abbrev-ref', 'HEAD']))
		const commit = fromEnv.commit ?? runScalar(['rev-parse', 'HEAD'])
		const commitTime = fromEnv.commitTime ?? runScalar(['show', '-s', '--format=%ct', 'HEAD'])
		// Depth is a better revision key than the timestamp, but only from a full
		// checkout: on a shallow clone `rev-list --count` answers the depth of the
		// CLONE (1 for the CI default), which would rank every run identically.
		const commitDepth = fromEnv.commitDepth ?? gitDepth()
		return {
			...(branch ? { branch } : {}),
			...(commit ? { commit } : {}),
			...(commitTime ? { commitTime } : {}),
			...(commitDepth ? { commitDepth } : {}),
		}
	} catch {
		return fromEnv
	}
}

/**
 * The branch name this CI provider reports, if any.
 *
 * Most CI systems check out a detached HEAD, so git itself cannot name the
 * branch — only the provider can, and each spells it differently. Without this
 * the branch reads as `HEAD`, `isDefaultBranch` rejects it, and the change
 * tracking index silently never fills on anything but GitHub Actions. Ordered
 * most-specific first; a merge-request variable is deliberately NOT consulted,
 * since a PR build is not a default-branch build.
 */
function ciBranch(): string | undefined {
	const env = process.env
	return nonEmptyBranch(
		env['GITHUB_REF_NAME'] // GitHub Actions
		?? env['CI_COMMIT_BRANCH'] // GitLab CI
		?? env['BUILDKITE_BRANCH'] // Buildkite
		?? env['CIRCLE_BRANCH'] // CircleCI
		?? env['BRANCH_NAME'] // Jenkins multibranch
		?? env['DRONE_BRANCH'] // Drone
		?? env['BITBUCKET_BRANCH'] // Bitbucket Pipelines
		?? env['CF_PAGES_BRANCH'], // Cloudflare Pages
	)
}

/** The commit's depth on its branch, or undefined when the checkout is shallow. */
function gitDepth(): string | undefined {
	if (runScalar(['rev-parse', '--is-shallow-repository']) !== 'false') return undefined
	const count = runScalar(['rev-list', '--count', 'HEAD'])
	return Number(count) > 0 ? count : undefined
}

/** A branch name, or undefined for the empty string and git's detached-HEAD placeholder. */
function nonEmptyBranch(value: string | undefined): string | undefined {
	const trimmed = value?.trim()
	return trimmed && trimmed !== 'HEAD' ? trimmed : undefined
}

/**
 * Run git with an argument VECTOR, never a command string.
 *
 * `execFileSync` spawns git directly, so no shell parses these arguments and
 * nothing here needs quoting. The previous string form did, and its quoting was
 * POSIX-only: `cmd.exe` treats single quotes as literal characters, so a ref
 * arrived as `'origin/main'` — quotes and all — and every ref-taking command
 * silently failed on Windows. Passing argv removes the question rather than
 * answering it per platform, and takes the shell-injection surface with it.
 */
function run(args: readonly string[]): string {
	const root = repoTop()
	// Run FROM THE REPOSITORY ROOT, not the current directory. `git ls-files` is
	// scoped to the directory it runs in, so `opice impact` invoked from
	// `packages/web` in a monorepo silently omitted every untracked file in a
	// sibling package — a newly added source file would then match no footprint
	// and its scenario would not be selected. `-C` also pins the `diff.relative`
	// output paths to the root, which is the shape the index is keyed on.
	const prefix = root ? ['-C', root] : []
	// RAW, untrimmed. A repository path may legitimately begin with a space or a
	// newline, and trimming here would eat the first one in `-z` output before it
	// was ever split — producing a path that matches no footprint and silently
	// drops its scenarios. Callers that want a single scalar trim it themselves.
	return execFileSync('git', [...prefix, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** Run git and return its output as one trimmed scalar — for single-value queries. */
function runScalar(args: readonly string[]): string {
	return run(args).trim()
}

/**
 * The repository root, resolved once, WITHOUT the `-C` prefix above — this is
 * the call that discovers it. Null outside a checkout, in which case commands
 * run wherever they were invoked and fail on their own terms.
 */
let cachedTop: string | null | undefined
function repoTop(): string | null {
	if (cachedTop === undefined) {
		try {
			cachedTop = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
		} catch {
			cachedTop = null
		}
	}
	return cachedTop
}

/** Run a git command, returning its non-empty output lines; [] if it fails. */
export function gitLines(...args: string[]): string[] {
	try {
		return run(args).split('\n').map((line) => line.trim()).filter(Boolean)
	} catch {
		return []
	}
}

/**
 * Run a git command that emits NUL-separated paths (`-z`), returning them raw.
 *
 * Path output must never go through {@link gitLines}: with git's default
 * `core.quotePath=true`, a non-ASCII name comes back C-quoted —
 * `"P\305\231ehled.tsx"` for `Přehled.tsx` — while the footprint holds the
 * decoded name, so the file would match nothing and its scenarios would silently
 * not run. `-z` sidesteps the quoting entirely and also survives paths
 * containing newlines.
 */
export function gitPaths(...args: string[]): string[] {
	try {
		return run(args).split('\0').filter(Boolean)
	} catch {
		return []
	}
}

/**
 * The paths a branch changed, relative to `base`.
 *
 * Uses the three-dot form (`base...HEAD`), i.e. everything since the merge base
 * — the same set a PR shows. Uncommitted work and untracked files are folded in
 * too, so running this locally mid-change reflects what you are actually
 * editing rather than your last commit.
 */
export function changedPaths(base: string): string[] {
	const paths = new Set<string>()
	// The base diff is the one that can legitimately FAIL: a shallow CI checkout
	// has no merge base, and a misspelled ref resolves to nothing. Swallowing that
	// into an empty list is the worst possible answer — it reads as "the branch
	// changed nothing", which since an empty diff is a valid success now means
	// `--impacted` adds nothing and says everything is fine. Throwing lets the
	// caller warn and fall back to the tier, which is what failing open means
	// here. The other two commands cannot fail this way: they name no ref.
	for (const path of gitPathsOrThrow('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`)) {
		paths.add(path)
	}
	for (const cmd of [
		// `--no-renames` is load-bearing, not a style choice. With rename detection
		// on, moving a file reports only its NEW path — but the index was built
		// from a run of the default branch, where the file still had its OLD one.
		// The scenario that uses it would then match nothing and quietly not run,
		// on precisely the kind of change most likely to break it. Turning
		// detection off reports the move as a delete + an add, so both paths are
		// queried and the old one finds the edge.
		['diff', '--name-only', '--no-renames', '-z', 'HEAD'],
		['ls-files', '--others', '--exclude-standard', '-z'],
	]) {
		for (const path of gitPaths(...cmd)) paths.add(path)
	}
	return [...paths]
}

/**
 * Like {@link gitPaths}, but a failing command THROWS rather than reading as an
 * empty result. For commands where "no output" and "could not run" mean opposite
 * things to the caller.
 */
export function gitPathsOrThrow(...args: string[]): string[] {
	return run(args).split('\0').filter(Boolean)
}

/**
 * The default base to diff against — the first of these refs that exists. Reads
 * the same CI environment as {@link detectGitMeta}, one variable over: a PR job
 * knows its base branch, and that is the right thing to diff against.
 */
export function defaultBase(): string {
	const local = [
		// `origin/HEAD` before the guesses: it is a LOCAL ref, so it costs nothing,
		// and it is the repository's own answer. A repo whose trunk is `develop`
		// usually still has an `origin/main` lying around, and preferring the guess
		// would diff against the wrong branch every time.
		symbolicDefaultBranch(),
		'origin/main',
		'origin/master',
		'main',
		'master',
	].filter((c): c is string => !!c)
	// An ANNOUNCED base is authoritative: if the environment named one, that is
	// the question being asked, and answering a different one is worse than not
	// answering. When the ref was never fetched, returning it anyway makes
	// `changedPaths` fail, which `resolveImpact` turns into a warning and a
	// fall back to the tier — a visibly unanswered query rather than a confident
	// diff against `origin/main` that omits half the PR.
	//
	// The guesses below are only for when nobody said. `OPICE_IMPACT_BASE` is the
	// operator's own word; the provider's PR target is the branch the request is
	// actually against, which is very often not the default one.
	const announced = process.env['OPICE_IMPACT_BASE'] ?? prBaseBranch()
	if (announced) return announced
	for (const candidate of local) {
		if (exists(candidate)) return candidate
	}
	// Only now ask the REMOTE — `git remote show origin` is a network and possibly
	// an auth round trip, so it must not run on the common path. Asked at all
	// because the fallback below diffs a single commit, hiding most of a
	// multi-commit branch.
	const remote = remoteDefaultBranch()
	if (remote && exists(remote)) return remote
	return 'HEAD~1'
}

/** The branch a pull/merge request targets, as `origin/<name>`, if we're in one. */
function prBaseBranch(): string | undefined {
	const env = process.env
	const name = env['GITHUB_BASE_REF'] // GitHub Actions
		?? env['CI_MERGE_REQUEST_TARGET_BRANCH_NAME'] // GitLab CI
		?? env['BUILDKITE_PULL_REQUEST_BASE_BRANCH'] // Buildkite
		?? env['BITBUCKET_PR_DESTINATION_BRANCH'] // Bitbucket Pipelines
		?? env['CHANGE_TARGET'] // Jenkins multibranch
		?? env['DRONE_TARGET_BRANCH'] // Drone
	const trimmed = name?.trim()
	return trimmed ? `origin/${trimmed}` : undefined
}

/** `origin`'s default branch from the LOCAL symbolic ref — no network. */
function symbolicDefaultBranch(): string | undefined {
	const [symbolic] = gitLines('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD')
	return symbolic ? symbolic.replace(/^refs\/remotes\//, '') : undefined
}

/** Does this ref resolve in the local repository? */
function exists(ref: string): boolean {
	return gitLines('rev-parse', '--verify', '--quiet', ref).length > 0
}

/** `origin`'s default branch, asked over the network. See {@link symbolicDefaultBranch} for the free path. */
function remoteDefaultBranch(): string | undefined {
	const line = gitLines('remote', 'show', 'origin').find((l) => l.includes('HEAD branch:'))
	const name = line?.split('HEAD branch:')[1]?.trim()
	return name && name !== '(unknown)' ? `origin/${name}` : undefined
}
