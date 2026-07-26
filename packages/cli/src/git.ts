import { execFileSync } from 'node:child_process'

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
		const branch = fromEnv.branch ?? run(['rev-parse', '--abbrev-ref', 'HEAD'])
		const commit = fromEnv.commit ?? run(['rev-parse', 'HEAD'])
		const commitTime = fromEnv.commitTime ?? run(['show', '-s', '--format=%ct', 'HEAD'])
		return {
			...(branch ? { branch } : {}),
			...(commit ? { commit } : {}),
			...(commitTime ? { commitTime } : {}),
		}
	} catch {
		return fromEnv
	}
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
	return execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
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
	for (const cmd of [
		// `-z` for the path output — see {@link gitPaths}.
		// `--no-renames` is load-bearing, not a style choice. With rename detection
		// on, moving a file reports only its NEW path — but the index was built
		// from a run of the default branch, where the file still had its OLD one.
		// The scenario that uses it would then match nothing and quietly not run,
		// on precisely the kind of change most likely to break it. Turning
		// detection off reports the move as a delete + an add, so both paths are
		// queried and the old one finds the edge.
		['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`],
		['diff', '--name-only', '--no-renames', '-z', 'HEAD'],
		['ls-files', '--others', '--exclude-standard', '-z'],
	]) {
		for (const path of gitPaths(...cmd)) paths.add(path)
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
