import { describe, expect, test } from 'bun:test'
import { ciBranch, ciCommit, INDEX_REASONS, isTruthyEnv, usableBranch } from './reporter'

// `source` is derived from this, and only a `ci` run of the default branch may
// replace the shared change-tracking index — so a misread here hands everyone
// else a developer's local working state.
describe('isTruthyEnv', () => {
	test.each(['1', 'true', 'TRUE', 'yes', 'on', 'anything'])('%s is CI', (value) => {
		expect(isTruthyEnv(value)).toBe(true)
	})

	test.each(['false', 'FALSE', '0', 'no', 'off', '', '  ', undefined])('%s is not CI', (value) => {
		expect(isTruthyEnv(value)).toBe(false)
	})

	test('ignores surrounding whitespace', () => {
		expect(isTruthyEnv(' false ')).toBe(false)
		expect(isTruthyEnv(' true ')).toBe(true)
	})
})

// A null branch is not cosmetic: the worker's default-branch gate rejects every
// footprint from a run it cannot attribute, so on non-GitHub CI the impact index
// would simply never populate, with nothing saying why.
describe('ciBranch', () => {
	test.each([
		['GITHUB_REF_NAME', 'main'],
		['CI_COMMIT_BRANCH', 'develop'],
		['BUILDKITE_BRANCH', 'main'],
		['CIRCLE_BRANCH', 'trunk'],
		['BRANCH_NAME', 'main'],
		['DRONE_BRANCH', 'main'],
		['BITBUCKET_BRANCH', 'main'],
		['CF_PAGES_BRANCH', 'production'],
	])('reads %s', (key, value) => {
		expect(ciBranch({ [key]: value } as NodeJS.ProcessEnv)).toBe(value)
	})

	test('prefers GitHub when several are present', () => {
		expect(ciBranch({ GITHUB_REF_NAME: 'gh', CI_COMMIT_BRANCH: 'gl' } as NodeJS.ProcessEnv)).toBe('gh')
	})

	test('is undefined with no provider variable', () => {
		expect(ciBranch({} as NodeJS.ProcessEnv)).toBeUndefined()
	})

	// A merge-request build is not a default-branch build, so no MR variable is read.
	test('ignores merge-request variables', () => {
		expect(ciBranch({ CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feat/x' } as NodeJS.ProcessEnv)).toBeUndefined()
	})
})

describe('usableBranch', () => {
	test('rejects git’s detached-HEAD placeholder', () => {
		expect(usableBranch('HEAD')).toBeUndefined()
	})

	test.each(['', '   ', undefined])('rejects %p', (value) => {
		expect(usableBranch(value)).toBeUndefined()
	})

	test('trims a real name', () => {
		expect(usableBranch('  main\n')).toBe('main')
	})
})

// The worker groups bun's per-test-file runs by commit_sha to build a scenario
// inventory, so a null SHA collapses a whole suite to one run and `unindexed`
// reports zero while sibling files go uninventoried.
describe('ciCommit', () => {
	test.each([
		['GITHUB_SHA', 'aaa111'],
		['CI_COMMIT_SHA', 'bbb222'],
		['BUILDKITE_COMMIT', 'ccc333'],
		['CIRCLE_SHA1', 'ddd444'],
		['GIT_COMMIT', 'eee555'],
		['DRONE_COMMIT_SHA', 'fff666'],
		['BITBUCKET_COMMIT', 'ggg777'],
		['CF_PAGES_COMMIT_SHA', 'hhh888'],
	])('reads %s', (key, value) => {
		expect(ciCommit({ [key]: value } as NodeJS.ProcessEnv)).toBe(value)
	})

	test('prefers GitHub when several are present', () => {
		expect(ciCommit({ GITHUB_SHA: 'gh', CI_COMMIT_SHA: 'gl' } as NodeJS.ProcessEnv)).toBe('gh')
	})

	test.each([{}, { GITHUB_SHA: '' }, { GITHUB_SHA: '   ' }])('is undefined for %p', (env) => {
		expect(ciCommit(env as NodeJS.ProcessEnv)).toBeUndefined()
	})
})

// Drone names the TARGET branch in DRONE_BRANCH on a pull-request build, so a PR
// into main would report itself as main, pass the worker's default-branch gate,
// and replace the shared index with feature-branch footprints.
describe('pull-request builds are never default-branch builds', () => {
	test('Drone prefers the source branch', () => {
		expect(ciBranch({
			DRONE_BRANCH: 'main',
			DRONE_SOURCE_BRANCH: 'feat/x',
			DRONE_TARGET_BRANCH: 'main',
		} as NodeJS.ProcessEnv)).toBe('feat/x')
	})

	test('a branch equal to the announced target is refused', () => {
		expect(ciBranch({ DRONE_BRANCH: 'main', DRONE_TARGET_BRANCH: 'main' } as NodeJS.ProcessEnv)).toBeUndefined()
	})

	test.each([
		['GITHUB_BASE_REF', 'GITHUB_REF_NAME'],
		['CI_MERGE_REQUEST_TARGET_BRANCH_NAME', 'CI_COMMIT_BRANCH'],
		['BUILDKITE_PULL_REQUEST_BASE_BRANCH', 'BUILDKITE_BRANCH'],
		['BITBUCKET_PR_DESTINATION_BRANCH', 'BITBUCKET_BRANCH'],
		['CHANGE_TARGET', 'BRANCH_NAME'],
	])('%s guards the same trap for its provider', (targetKey, branchKey) => {
		expect(ciBranch({ [targetKey]: 'main', [branchKey]: 'main' } as NodeJS.ProcessEnv)).toBeUndefined()
		expect(ciBranch({ [targetKey]: 'main', [branchKey]: 'feat/x' } as NodeJS.ProcessEnv)).toBe('feat/x')
	})

	test('a plain push build is unaffected', () => {
		expect(ciBranch({ GITHUB_REF_NAME: 'main' } as NodeJS.ProcessEnv)).toBe('main')
	})
})

// `indexed: false` covers cases that mean opposite things. Telling someone their
// branch is misconfigured when the index is simply already current sends them to
// change settings that were never wrong.
describe('index reasons', () => {
	test('every reason the worker can send has an explanation', () => {
		const fromWorker = [
			'not-ci', 'not-default-branch', 'incomplete-walkthrough',
			'no-commit-time', 'nothing-measured', 'already-current', 'index-error',
		]
		for (const reason of fromWorker) {
			expect(INDEX_REASONS[reason]).toBeTruthy()
		}
	})

	test('an unknown or absent reason falls back', () => {
		expect(INDEX_REASONS['']).toBeTruthy()
		expect(INDEX_REASONS['something-new'] ?? INDEX_REASONS['']).toBe(INDEX_REASONS[''] as string)
	})

	// The two that mean "nothing is wrong" must not read as a problem.
	test('already-current does not blame the branch', () => {
		expect(INDEX_REASONS['already-current']).toContain('Nothing is wrong')
		expect(INDEX_REASONS['already-current']).not.toContain('default branch')
	})
})
