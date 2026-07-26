import { describe, expect, test } from 'bun:test'
import { isTruthyEnv } from './reporter'

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
