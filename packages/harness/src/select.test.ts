import { describe, expect, test } from 'bun:test'
import { decideScenarioRun, isScenarioSelected, normalizeSelectPath, parseSelectList, splitSelect } from './select.js'

describe('splitSelect', () => {
	test('empty / undefined → []', () => {
		expect(splitSelect(undefined)).toEqual([])
		expect(splitSelect('')).toEqual([])
		expect(splitSelect('  ')).toEqual([])
		expect(splitSelect(',, ,')).toEqual([])
	})

	test('splits, trims, drops blanks', () => {
		expect(splitSelect('a.test.ts, b.test.ts ,,c.test.ts')).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
	})
})

describe('parseSelectList', () => {
	test('reads OPICE_SELECT from the passed env', () => {
		expect(parseSelectList({ OPICE_SELECT: 'tests/browser/x.test.ts' })).toEqual(['tests/browser/x.test.ts'])
		expect(parseSelectList({})).toEqual([])
	})
})

describe('normalizeSelectPath', () => {
	test('strips file://, leading ./, backslashes, trailing slash', () => {
		expect(normalizeSelectPath('file:///abs/x.test.ts')).toBe('/abs/x.test.ts')
		expect(normalizeSelectPath('./tests/browser/x.test.ts')).toBe('tests/browser/x.test.ts')
		expect(normalizeSelectPath('././x.test.ts')).toBe('x.test.ts')
		expect(normalizeSelectPath('tests\\browser\\x.test.ts')).toBe('tests/browser/x.test.ts')
		expect(normalizeSelectPath('tests/browser/')).toBe('tests/browser')
		expect(normalizeSelectPath('/')).toBe('/')
	})
})

describe('isScenarioSelected', () => {
	const list = ['tests/browser/edu-program-publish.test.ts', 'tests/browser/crm-org.test.ts']

	test('no testFile or empty list → false', () => {
		expect(isScenarioSelected(undefined, list)).toBe(false)
		expect(isScenarioSelected('tests/browser/edu-program-publish.test.ts', [])).toBe(false)
	})

	test('exact repo-relative match', () => {
		expect(isScenarioSelected('tests/browser/edu-program-publish.test.ts', list)).toBe(true)
	})

	test('not in the list → false', () => {
		expect(isScenarioSelected('tests/browser/edu-program-create.test.ts', list)).toBe(false)
	})

	test('absolute testFile matches a repo-relative entry (suffix)', () => {
		expect(isScenarioSelected('/home/runner/work/npi/npi/tests/browser/crm-org.test.ts', list)).toBe(true)
	})

	test('repo-relative testFile matches an absolute entry (suffix)', () => {
		expect(isScenarioSelected('tests/browser/crm-org.test.ts', ['/abs/repo/tests/browser/crm-org.test.ts'])).toBe(true)
	})

	test('leading ./ and backslashes are tolerated on both sides', () => {
		expect(isScenarioSelected('./tests/browser/crm-org.test.ts', list)).toBe(true)
		expect(isScenarioSelected('tests\\browser\\crm-org.test.ts', list)).toBe(true)
	})

	test('bare filename entry matches on basename', () => {
		expect(isScenarioSelected('tests/browser/crm-org.test.ts', ['crm-org.test.ts'])).toBe(true)
		// a path entry (has a slash) does NOT degrade to a basename match
		expect(isScenarioSelected('tests/browser/crm-org.test.ts', ['other/crm-org.test.ts'])).toBe(false)
	})

	test('a suffix that is not on a path boundary does not match', () => {
		// "org.test.ts" is a string-suffix of "crm-org.test.ts" but not a path segment
		expect(isScenarioSelected('tests/browser/crm-org.test.ts', ['org.test.ts'])).toBe(false)
	})
})

describe('decideScenarioRun (the no-double-run gate)', () => {
	const TF = 'tests/browser/x.test.ts'

	test('within the selected tier → runs, reason "tier"', () => {
		expect(decideScenarioRun('critical', 'critical', TF, [])).toEqual({ run: true, reason: 'tier' })
		expect(decideScenarioRun('standard', 'standard', TF, [])).toEqual({ run: true, reason: 'tier' })
		expect(decideScenarioRun('critical', 'standard', TF, [])).toEqual({ run: true, reason: 'tier' })
	})

	test('above the tier but explicitly selected → runs, reason "selected"', () => {
		expect(decideScenarioRun('standard', 'critical', TF, [TF])).toEqual({ run: true, reason: 'selected' })
		expect(decideScenarioRun('extended', 'standard', TF, [TF])).toEqual({ run: true, reason: 'selected' })
	})

	test('above the tier and not selected → skipped', () => {
		expect(decideScenarioRun('standard', 'critical', TF, [])).toEqual({ run: false, reason: 'skipped' })
		expect(decideScenarioRun('extended', 'standard', TF, ['tests/browser/other.test.ts'])).toEqual({ run: false, reason: 'skipped' })
	})

	test('KEY INVARIANT: a critical scenario that is ALSO in the select list reports "tier", not "selected"', () => {
		// The caller registers/runs exactly once; "tier" wins so it is never treated
		// as a second, selected entry → a changed critical scenario is not run twice.
		const gate = decideScenarioRun('critical', 'critical', TF, [TF])
		expect(gate).toEqual({ run: true, reason: 'tier' })
	})
})
