import { describe, expect, test } from 'bun:test'
import { normalizeFramePath, TEST_FRAME_RE } from './scenario'

/** What `captureTestFile` does to one stack line. */
function parse(frame: string): string | null {
	const match = frame.match(TEST_FRAME_RE)
	return match?.[1] ? normalizeFramePath(match[1]) : null
}

describe('test-file stack frames', () => {
	test.each([
		['bare path', '    at /repo/apps/web/checkout.test.ts:3:1', '/repo/apps/web/checkout.test.ts'],
		['parenthesised', '    at Object.<anonymous> (/repo/apps/web/checkout.test.ts:3:1)', '/repo/apps/web/checkout.test.ts'],
		['file URL', '    at file:///repo/apps/web/checkout.test.ts:3:1', '/repo/apps/web/checkout.test.ts'],
		['no line/col', '    at /repo/apps/web/checkout.test.ts', '/repo/apps/web/checkout.test.ts'],
		['.spec.tsx', '    at /repo/a/b.spec.tsx:1:1', '/repo/a/b.spec.tsx'],
	])('parses a %s', (_label, frame, expected) => {
		expect(parse(frame)).toBe(expected)
	})

	// A space in the checkout path is not exotic — `~/My Project/…` on macOS hit
	// this, and the scenario was indexed with no test file at all.
	test('parses a path containing spaces', () => {
		expect(parse('    at /Users/me/My Project/apps/checkout.test.ts:3:1'))
			.toBe('/Users/me/My Project/apps/checkout.test.ts')
	})

	test('decodes percent-escapes only in a file URL', () => {
		expect(parse('    at file:///Users/me/My%20Project/a.test.ts:1:1'))
			.toBe('/Users/me/My Project/a.test.ts')
		// A bare path with a literal %20 in its name means exactly that.
		expect(parse('    at /Users/me/My%20Project/a.test.ts:1:1'))
			.toBe('/Users/me/My%20Project/a.test.ts')
	})

	test.each([
		['drive letter', '    at C:\\repo\\apps\\checkout.test.ts:3:1', 'C:\\repo\\apps\\checkout.test.ts'],
		['drive letter in parens', '    at (C:\\repo\\apps\\checkout.test.ts:3:1)', 'C:\\repo\\apps\\checkout.test.ts'],
		['file URL with drive', '    at file:///C:/repo/apps/checkout.test.ts:3:1', 'C:/repo/apps/checkout.test.ts'],
	])('parses a Windows %s', (_label, frame, expected) => {
		expect(parse(frame)).toBe(expected)
	})

	test('ignores frames that are not test files', () => {
		expect(parse('    at browserTest (/repo/packages/harness/src/scenario.ts:12:5)')).toBeNull()
		expect(parse('    at /repo/src/attestation.ts:1:1')).toBeNull()
	})
})
