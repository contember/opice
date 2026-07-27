import { describe, expect, test } from 'bun:test'
import { exercisedRanges } from './coverage'

describe('exercisedRanges', () => {
	const fn = (functionName: string, start: number, end: number, count = 1) => ({
		functionName,
		ranges: [{ startOffset: start, endOffset: end, count }],
	})

	// The module top level runs on import alone — counting it made every loaded
	// file look touched and destroyed impact selection.
	test('excludes the script root', () => {
		expect(exercisedRanges([fn('', 0, 500)])).toEqual([])
	})

	test('keeps named functions', () => {
		expect(exercisedRanges([fn('', 0, 500), fn('handleSubmit', 40, 120)]))
			.toEqual([{ start: 40, end: 120, count: 1 }])
	})

	// V8 leaves the name empty for inline callbacks too. Dropping those marked a
	// file whose behaviour lives in handlers as never exercised.
	test('keeps a called anonymous callback', () => {
		expect(exercisedRanges([fn('', 0, 500), fn('', 60, 90)]))
			.toEqual([{ start: 60, end: 90, count: 1 }])
	})

	test('root detection is by offset, not by ordering', () => {
		expect(exercisedRanges([fn('', 60, 90), fn('', 0, 500)]))
			.toEqual([{ start: 60, end: 90, count: 1 }])
	})

	// A named function starting at offset 0 is real code, not a wrapper.
	test('does not mistake a named function at offset 0 for the root', () => {
		expect(exercisedRanges([fn('main', 0, 500)]))
			.toEqual([{ start: 0, end: 500, count: 1 }])
	})

	test('carries the count through, so uncalled code stays uncalled', () => {
		expect(exercisedRanges([fn('never', 10, 20, 0)]))
			.toEqual([{ start: 10, end: 20, count: 0 }])
	})
})
