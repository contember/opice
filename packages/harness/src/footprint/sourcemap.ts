/**
 * Just enough source-map machinery to answer one question: **which source files
 * did the executed bytes of this bundle come from?**
 *
 * Naively, a bundle's source map already lists every file that went into it —
 * and using that list would be worse than useless, because every scenario would
 * then "touch" every file in the app. The list has to be intersected with what
 * V8 actually executed, which means decoding the mappings and locating the
 * covered byte ranges inside them.
 *
 * Only the `mappings` field is decoded, and only its generated position and
 * source index are kept — original line/column and names are irrelevant to a
 * file-level footprint, so they're skipped rather than stored.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/**
 * char code → base64 digit, or -1. A bundle's `mappings` field runs to
 * megabytes, so this is decoded a character at a time — an array indexed by
 * `charCodeAt` avoids allocating a one-character string and hashing it for each
 * of those millions of reads.
 */
const BASE64_LOOKUP = (() => {
	const table = new Int8Array(128).fill(-1)
	for (let i = 0; i < BASE64_ALPHABET.length; i++) table[BASE64_ALPHABET.charCodeAt(i)] = i
	return table
})()

/** The fields of a source map we need. */
export interface RawSourceMap {
	version?: number
	sources: string[]
	sourceRoot?: string
	mappings: string
	/** Index-map sections; unsupported — see {@link parseSourceMap}. */
	sections?: unknown
}

/** One decoded mapping: a generated position and the source it came from. */
export interface Mapping {
	/** Absolute byte offset into the generated file. */
	offset: number
	sourceIndex: number
}

/**
 * Decode a VLQ-encoded field list starting at `i`. Returns the values and the
 * index just past the segment. Malformed input stops the segment rather than
 * throwing — a broken map degrades to fewer mappings.
 */
function decodeSegment(text: string, start: number): { values: number[]; next: number } {
	const values: number[] = []
	let i = start
	while (i < text.length && text[i] !== ',' && text[i] !== ';') {
		let result = 0
		let shift = 0
		let continuation = true
		while (continuation) {
			if (i >= text.length) break
			const code = text.charCodeAt(i)
			const digit = code < 128 ? (BASE64_LOOKUP[code] as number) : -1
			if (digit < 0) {
				// Not a VLQ character — abandon this segment.
				return { values, next: i + 1 }
			}
			i++
			continuation = (digit & 32) !== 0
			result += (digit & 31) * 2 ** shift
			shift += 5
		}
		const negative = (result & 1) === 1
		result = Math.floor(result / 2)
		values.push(negative ? -result : result)
	}
	return { values, next: i }
}

/** Byte offset at which each line of `source` starts. */
export function lineStartOffsets(source: string): number[] {
	const starts = [0]
	for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) {
		starts.push(i + 1)
	}
	return starts
}

/**
 * Decode a `mappings` string into generated-offset → source-index pairs, sorted
 * by offset. `lineStarts` converts the map's (line, column) coordinates into the
 * absolute offsets that V8 coverage ranges use.
 *
 * Segments with fewer than 4 fields carry no source and are skipped — they mark
 * generated code with no original (a bundler's own glue), which belongs to no
 * file.
 */
export function decodeMappings(mappings: string, lineStarts: number[]): Mapping[] {
	const out: Mapping[] = []
	let generatedLine = 0
	let generatedColumn = 0
	let sourceIndex = 0
	let i = 0
	while (i < mappings.length) {
		const char = mappings[i]
		if (char === ';') {
			generatedLine++
			generatedColumn = 0
			i++
			continue
		}
		if (char === ',') {
			i++
			continue
		}
		const { values, next } = decodeSegment(mappings, i)
		i = next
		if (values.length === 0) continue
		generatedColumn += values[0] as number
		const lineStart = lineStarts[generatedLine]
		if (values.length >= 4) {
			sourceIndex += values[1] as number
			if (lineStart !== undefined) {
				out.push({ offset: lineStart + generatedColumn, sourceIndex })
			}
		} else if (lineStart !== undefined) {
			// A one-field segment maps a generated position to NO source — bundler
			// glue, a runtime helper, a module wrapper. It is a boundary, so it has
			// to be recorded: dropping it lets the preceding mapping run on through
			// the generated code to the next real segment, and if V8 executed that
			// glue the bytes are credited to a source file that was never called —
			// which then reads `exercised` and gets selected by every impact query.
			out.push({ offset: lineStart + generatedColumn, sourceIndex: UNMAPPED })
		}
	}
	out.sort((a, b) => a.offset - b.offset)
	return out
}

/**
 * Sentinel `sourceIndex` for a generated position that maps to no source at all.
 * A real index is always >= 0, so this can never collide with one.
 */
export const UNMAPPED = -1

export interface CoverageRange {
	start: number
	end: number
	count: number
}

/**
 * Flatten V8's nested coverage ranges into a non-overlapping sequence.
 *
 * V8 reports a function's range plus nested ranges for its uncovered branches;
 * an inner range's count *overrides* its parent's over the bytes it spans. So
 * "which bytes ran" can't be read off the ranges directly — they have to be
 * painted outermost-first, which is what the stack below does.
 */
export function flattenRanges(ranges: readonly CoverageRange[]): CoverageRange[] {
	const sorted = [...ranges].sort((a, b) => (a.start - b.start) || (b.end - a.end))
	const out: CoverageRange[] = []
	const stack: CoverageRange[] = []
	let cursor = 0
	const emit = (start: number, end: number, count: number): void => {
		if (end <= start) return
		const last = out[out.length - 1]
		if (last && last.end === start && last.count === count) last.end = end
		else out.push({ start, end, count })
	}
	for (const range of sorted) {
		// Close any enclosing range that ends before this one starts.
		while (stack.length > 0 && (stack[stack.length - 1] as CoverageRange).end <= range.start) {
			const top = stack.pop() as CoverageRange
			emit(cursor, top.end, top.count)
			cursor = Math.max(cursor, top.end)
		}
		const parent = stack[stack.length - 1]
		if (parent) emit(cursor, range.start, parent.count)
		cursor = Math.max(cursor, range.start)
		stack.push({ ...range })
	}
	while (stack.length > 0) {
		const top = stack.pop() as CoverageRange
		emit(cursor, top.end, top.count)
		cursor = Math.max(cursor, top.end)
	}
	return out.filter((r) => r.end > r.start)
}

/**
 * Executed bytes per source index: intersect the covered (count > 0) regions of
 * the generated file with the mappings, attributing each mapping's span to its
 * source.
 *
 * A mapping's span runs from its own offset to the next mapping's offset — an
 * approximation, but the right one at this granularity: we only need to know
 * *which* files ran and roughly how much, never which line.
 */
export function executedBytesBySource(mappings: readonly Mapping[], covered: readonly CoverageRange[]): Map<number, number> {
	const bySource = new Map<number, number>()
	if (mappings.length === 0) return bySource
	let mappingIndex = 0
	for (const range of covered) {
		if (range.count <= 0) continue
		// Rewind to the last mapping at or before the range start (mappings and
		// ranges are both sorted, so this walks forward overall).
		while (mappingIndex > 0 && (mappings[mappingIndex] as Mapping).offset > range.start) mappingIndex--
		while (mappingIndex + 1 < mappings.length && (mappings[mappingIndex + 1] as Mapping).offset <= range.start) mappingIndex++
		for (let i = mappingIndex; i < mappings.length; i++) {
			const mapping = mappings[i] as Mapping
			const nextOffset = i + 1 < mappings.length ? (mappings[i + 1] as Mapping).offset : Number.MAX_SAFE_INTEGER
			if (nextOffset <= range.start) continue
			if (mapping.offset >= range.end) break
			const from = Math.max(mapping.offset, range.start)
			const to = Math.min(nextOffset, range.end)
			// The boundary marker attributes to nothing — that is its whole purpose.
			if (mapping.sourceIndex === UNMAPPED) continue
			if (to > from) bySource.set(mapping.sourceIndex, (bySource.get(mapping.sourceIndex) ?? 0) + (to - from))
		}
	}
	return bySource
}

/** Total bytes attributed to each source index, regardless of execution. */
export function totalBytesBySource(mappings: readonly Mapping[], generatedLength: number): Map<number, number> {
	const bySource = new Map<number, number>()
	for (let i = 0; i < mappings.length; i++) {
		const mapping = mappings[i] as Mapping
		const nextOffset = i + 1 < mappings.length ? (mappings[i + 1] as Mapping).offset : generatedLength
		if (mapping.sourceIndex === UNMAPPED) continue
		const span = Math.max(0, nextOffset - mapping.offset)
		bySource.set(mapping.sourceIndex, (bySource.get(mapping.sourceIndex) ?? 0) + span)
	}
	return bySource
}

/** The `//# sourceMappingURL=` of a generated file, or null. */
export function readSourceMappingUrl(source: string): string | null {
	// Anchored on the LAST occurrence of the marker rather than on a fixed-size
	// tail. An INLINE map is a `data:` URI holding the whole source map — tens or
	// hundreds of kilobytes — so a 2 KB window landed inside the base64 payload,
	// past the `sourceMappingURL=` that introduces it, and the reference was
	// missed entirely. `lastIndexOf` is a native scan and costs far less than the
	// megabytes of bundle it walks.
	const marker = source.lastIndexOf('sourceMappingURL')
	if (marker === -1) return null
	// A few characters back for the `//#` or `/*@` that must precede it.
	const from = Math.max(0, marker - 8)
	const match = /[#@]\s*sourceMappingURL\s*=\s*(\S+)/g
	let last: RegExpExecArray | null = null
	let current: RegExpExecArray | null
	const tail = source.slice(from)
	while ((current = match.exec(tail)) !== null) last = current
	return last?.[1] ?? null
}

/** Decode an inline `data:` source map. Returns null for anything else. */
export function decodeInlineSourceMap(url: string): RawSourceMap | null {
	if (!url.startsWith('data:')) return null
	const comma = url.indexOf(',')
	if (comma === -1) return null
	const meta = url.slice(0, comma)
	const payload = url.slice(comma + 1)
	try {
		const text = meta.includes(';base64') ? Buffer.from(payload, 'base64').toString('utf-8') : decodeURIComponent(payload)
		return parseSourceMap(text)
	} catch {
		return null
	}
}

/**
 * Parse a source map, returning null unless it has the fields we need.
 *
 * An **index map** (`sections`, emitted by esbuild/webpack for some multi-chunk
 * builds) is not supported and reads as null. That's a real gap rather than a
 * malformed file, so it's reported separately — a silently unattributed bundle
 * would look like "this scenario touches no files".
 */
export function parseSourceMap(text: string): RawSourceMap | null {
	try {
		const parsed = JSON.parse(text) as Partial<RawSourceMap>
		if (Array.isArray(parsed.sections)) return null
		if (!Array.isArray(parsed.sources) || typeof parsed.mappings !== 'string') return null
		return { sources: parsed.sources, mappings: parsed.mappings, ...(parsed.sourceRoot ? { sourceRoot: parsed.sourceRoot } : {}) }
	} catch {
		return null
	}
}

/** Is this an index map (`sections`) — supported by bundlers, not by us? */
export function isIndexSourceMap(text: string): boolean {
	try {
		return Array.isArray((JSON.parse(text) as { sections?: unknown }).sections)
	} catch {
		return false
	}
}
