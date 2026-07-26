import { execSync } from 'node:child_process'

/**
 * Best-effort git metadata for the current working tree. Returns the values
 * configured in opice runs (branch, commit). Falls back to env vars commonly
 * set by CI (GITHUB_REF_NAME, GITHUB_SHA) when not in a git checkout.
 */
export function detectGitMeta(): { branch?: string; commit?: string; commitTime?: string } {
	const fromEnv = {
		branch: process.env['OPICE_BRANCH'] ?? process.env['GITHUB_REF_NAME'],
		commit: process.env['OPICE_COMMIT'] ?? process.env['GITHUB_SHA'],
		commitTime: process.env['OPICE_COMMIT_TIME'],
	}
	// The commit TIME is what orders the change-tracking index: re-running an old
	// workflow gives it a fresh start time but not a fresh commit, and without
	// this the rerun would outrank a newer commit and restore stale edges.
	try {
		const branch = fromEnv.branch ?? run('git rev-parse --abbrev-ref HEAD')
		const commit = fromEnv.commit ?? run('git rev-parse HEAD')
		const commitTime = fromEnv.commitTime ?? run('git show -s --format=%ct HEAD')
		return {
			...(branch ? { branch } : {}),
			...(commit ? { commit } : {}),
			...(commitTime ? { commitTime } : {}),
		}
	} catch {
		return fromEnv
	}
}

function run(cmd: string): string {
	return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

/** Run a git command, returning its non-empty output lines; [] if it fails. */
export function gitLines(cmd: string): string[] {
	try {
		return run(cmd).split('\n').map((line) => line.trim()).filter(Boolean)
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
	for (const cmd of [
		// `--no-renames` is load-bearing, not a style choice. With rename detection
		// on, moving a file reports only its NEW path — but the index was built
		// from a run of the default branch, where the file still had its OLD one.
		// The scenario that uses it would then match nothing and quietly not run,
		// on precisely the kind of change most likely to break it. Turning
		// detection off reports the move as a delete + an add, so both paths are
		// queried and the old one finds the edge.
		`git diff --name-only --no-renames ${shellQuote(base)}...HEAD`,
		'git diff --name-only --no-renames HEAD',
		'git ls-files --others --exclude-standard',
	]) {
		for (const line of gitLines(cmd)) paths.add(line)
	}
	return [...paths]
}

/**
 * The default base to diff against — the first of these refs that exists. Reads
 * the same CI environment as {@link detectGitMeta}, one variable over: a PR job
 * knows its base branch, and that is the right thing to diff against.
 */
export function defaultBase(): string {
	const local = [
		process.env['OPICE_IMPACT_BASE'],
		process.env['GITHUB_BASE_REF'] ? `origin/${process.env['GITHUB_BASE_REF']}` : undefined,
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

/** `origin`'s default branch from the LOCAL symbolic ref — no network. */
function symbolicDefaultBranch(): string | undefined {
	const [symbolic] = gitLines('git symbolic-ref --quiet refs/remotes/origin/HEAD')
	return symbolic ? symbolic.replace(/^refs\/remotes\//, '') : undefined
}

/** Does this ref resolve in the local repository? */
function exists(ref: string): boolean {
	return gitLines(`git rev-parse --verify --quiet ${shellQuote(ref)}`).length > 0
}

/** `origin`'s default branch, asked over the network. See {@link symbolicDefaultBranch} for the free path. */
function remoteDefaultBranch(): string | undefined {
	const line = gitLines('git remote show origin').find((l) => l.includes('HEAD branch:'))
	const name = line?.split('HEAD branch:')[1]?.trim()
	return name && name !== '(unknown)' ? `origin/${name}` : undefined
}

/** Single-quote a ref for the shell. Refs can contain `/` and `-`, never a quote we'd need to escape. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}
