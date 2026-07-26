import { describe, expect, test } from 'bun:test'
import { ciBranch, ciCommit, isTruthyEnv, usableBranch } from './reporter'

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
