import { describe, expect, test } from 'bun:test'
import {
	decodeInlineSourceMap,
	decodeMappings,
	executedBytesBySource,
	flattenRanges,
	lineStartOffsets,
	parseSourceMap,
	readSourceMappingUrl,
	UNMAPPED,
} from './sourcemap.js'

describe('lineStartOffsets', () => {
	test('marks the offset of every line', () => {
		expect(lineStartOffsets('ab\ncd\n\nef')).toEqual([0, 3, 6, 7])
	})
})

describe('decodeMappings', () => {
	test('decodes generated offsets and source indexes', () => {
		// One line, two segments: col 0 → source 0, col 5 → source 1.
		// VLQ: 'AAAA' = [0,0,0,0]; 'KCAA' = [+5,+1,0,0].
		const mappings = decodeMappings('AAAA,KCAA', lineStartOffsets('0123456789'))
		expect(mappings).toEqual([
			{ offset: 0, sourceIndex: 0 },
			{ offset: 5, sourceIndex: 1 },
		])
	})

	test('resets the column on each generated line', () => {
		const mappings = decodeMappings('AAAA;AAAA', lineStartOffsets('abc\ndef'))
		expect(mappings).toEqual([
			{ offset: 0, sourceIndex: 0 },
			{ offset: 4, sourceIndex: 0 },
		])
	})

	// This used to assert that a source-less segment was dropped entirely, which
	// was the bug: it is a BOUNDARY. Dropping it let the preceding mapping run on
	// through bundler glue to the next real segment, and if V8 executed that glue
	// the bytes were credited to a source file nothing had called — which then
	// read `exercised` and was selected by every impact query.
	test('records a source-less segment as an unmapped boundary', () => {
		expect(decodeMappings('A', lineStartOffsets('abc'))).toEqual([
			{ offset: 0, sourceIndex: UNMAPPED },
		])
	})

	test('an unmapped boundary terminates the preceding mapping', () => {
		// Segment 1 maps offset 0 to source 0; segment 2 (one field) is glue at
		// offset 2; segment 3 maps offset 4 back to a source.
		const mappings = decodeMappings('AAAA,E,EAAA', lineStartOffsets('abcdefgh'))
		expect(mappings.map((m) => m.sourceIndex)).toEqual([0, UNMAPPED, 0])
	})

	test('unmapped bytes are attributed to no source', () => {
		const mappings = decodeMappings('AAAA,E,EAAA', lineStartOffsets('abcdefgh'))
		// One range covering everything: only the mapped spans should be counted.
		const executed = executedBytesBySource(mappings, [{ start: 0, end: 8, count: 1 }])
		expect(executed.has(UNMAPPED)).toBe(false)
		// 0–2 and 4–8 are source 0; 2–4 is glue and belongs to nobody.
		expect(executed.get(0)).toBe(6)
	})

	test('degrades rather than throwing on a malformed mappings string', () => {
		expect(() => decodeMappings('AAAA,!!!!,AAAA', lineStartOffsets('abcdefgh'))).not.toThrow()
	})
})

describe('flattenRanges', () => {
	test('lets an inner range override its parent', () => {
		// A covered function 0..100 with an uncovered branch 40..60.
		expect(flattenRanges([{ start: 0, end: 100, count: 1 }, { start: 40, end: 60, count: 0 }])).toEqual([
			{ start: 0, end: 40, count: 1 },
			{ start: 40, end: 60, count: 0 },
			{ start: 60, end: 100, count: 1 },
		])
	})

	test('merges adjacent segments with the same count', () => {
		expect(flattenRanges([{ start: 0, end: 10, count: 1 }, { start: 10, end: 20, count: 1 }])).toEqual([
			{ start: 0, end: 20, count: 1 },
		])
	})

	test('handles an uncovered function inside a covered one', () => {
		const flat = flattenRanges([
			{ start: 0, end: 100, count: 1 },
			{ start: 20, end: 80, count: 0 },
			{ start: 40, end: 60, count: 3 },
		])
		expect(flat).toEqual([
			{ start: 0, end: 20, count: 1 },
			{ start: 20, end: 40, count: 0 },
			{ start: 40, end: 60, count: 3 },
			{ start: 60, end: 80, count: 0 },
			{ start: 80, end: 100, count: 1 },
		])
	})

	test('is empty for no ranges', () => {
		expect(flattenRanges([])).toEqual([])
	})
})

describe('executedBytesBySource', () => {
	const mappings = [
		{ offset: 0, sourceIndex: 0 },
		{ offset: 100, sourceIndex: 1 },
		{ offset: 200, sourceIndex: 2 },
	]

	test('attributes covered bytes to the source that generated them', () => {
		const bytes = executedBytesBySource(mappings, [{ start: 0, end: 150, count: 1 }])
		expect(bytes.get(0)).toBe(100)
		expect(bytes.get(1)).toBe(50)
		expect(bytes.has(2)).toBe(false)
	})

	test('ignores uncovered regions', () => {
		const bytes = executedBytesBySource(mappings, [
			{ start: 0, end: 100, count: 0 },
			{ start: 100, end: 200, count: 2 },
		])
		expect(bytes.has(0)).toBe(false)
		expect(bytes.get(1)).toBe(100)
	})

	test('handles several disjoint covered regions', () => {
		const bytes = executedBytesBySource(mappings, [
			{ start: 10, end: 20, count: 1 },
			{ start: 210, end: 240, count: 1 },
		])
		expect(bytes.get(0)).toBe(10)
		expect(bytes.get(2)).toBe(30)
	})
})

describe('source map discovery', () => {
	test('reads the sourceMappingURL comment from the tail', () => {
		expect(readSourceMappingUrl('const a = 1\n//# sourceMappingURL=app.js.map\n')).toBe('app.js.map')
		expect(readSourceMappingUrl('const a = 1')).toBeNull()
	})

	test('decodes an inline base64 map', () => {
		const map = { version: 3, sources: ['src/a.ts'], mappings: 'AAAA' }
		const url = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
		expect(decodeInlineSourceMap(url)?.sources).toEqual(['src/a.ts'])
	})

	test('rejects a map without the fields we need', () => {
		expect(parseSourceMap('{"version":3}')).toBeNull()
		expect(parseSourceMap('not json')).toBeNull()
	})
})

describe('readSourceMappingUrl', () => {
	test('finds an ordinary external reference', () => {
		expect(readSourceMappingUrl('code();\n//# sourceMappingURL=app.js.map')).toBe('app.js.map')
	})

	// An inline map is a data: URI holding the entire source map. A fixed 2 KB
	// window landed inside the base64 payload, past the marker that introduces it.
	test('finds an inline data URI far longer than 2 KB', () => {
		const payload = 'A'.repeat(50_000)
		const source = `code();\n//# sourceMappingURL=data:application/json;base64,${payload}`
		expect(readSourceMappingUrl(source)).toBe(`data:application/json;base64,${payload}`)
	})

	test('takes the LAST reference when a bundle carries several', () => {
		const source = '//# sourceMappingURL=first.map\ncode();\n//# sourceMappingURL=second.map'
		expect(readSourceMappingUrl(source)).toBe('second.map')
	})

	test('is null when there is no reference', () => {
		expect(readSourceMappingUrl('just some code')).toBeNull()
	})
})

describe('inline source map size cap', () => {
	test('decodes an ordinary inline map', () => {
		const map = JSON.stringify({ version: 3, sources: ['a.ts'], mappings: 'AAAA' })
		const url = `data:application/json;base64,${Buffer.from(map).toString('base64')}`
		expect(decodeInlineSourceMap(url)?.sources).toEqual(['a.ts'])
	})

	// The encoded URI is already resident as part of the script; decoding adds a
	// buffer, a string and a parsed object on top, and this path had none of the
	// caps the external one has.
	test('refuses an oversized payload before decoding it', () => {
		const url = `data:application/json;base64,${'A'.repeat(33 * 1024 * 1024)}`
		expect(decodeInlineSourceMap(url)).toBeNull()
	})
})
