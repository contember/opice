/**
 * Tolerant scanner primitives — the character-level machinery the parser sits on.
 *
 * The blanker and the block matcher are deliberately grammar-agnostic, because
 * the Contember schema plugin scans TypeScript source with exactly the same two
 * tools and only different delimiters. They live here, next to their busiest
 * caller, rather than in a third module that would exist to hold one function.
 */

/** One kind of comment or string literal, as the pair of delimiters that bound it. */
interface LiteralRule {
	open: string
	close: string
	/** A backslash escapes the next character, so `\"` does not close the literal. */
	escapes?: boolean
	/** Leave the closing delimiter alone — a line comment must keep its newline. */
	keepClose?: boolean
}

interface LiteralGrammar {
	/** Rules bucketed by opening character: one map lookup per character scanned. */
	rules: Map<string, LiteralRule[]>
	/**
	 * Keep newlines inside a blanked literal. TypeScript does, so a block comment
	 * can't merge the lines around it; the GraphQL scan is line-agnostic.
	 */
	keepNewlines: boolean
}

/** Longest opener first within a bucket: `"""` must be tried before `"`. */
function grammar(rules: readonly LiteralRule[], keepNewlines: boolean): LiteralGrammar {
	const buckets = new Map<string, LiteralRule[]>()
	for (const rule of rules) {
		const key = rule.open.charAt(0)
		const bucket = buckets.get(key)
		if (bucket) bucket.push(rule)
		else buckets.set(key, [rule])
	}
	return { rules: buckets, keepNewlines }
}

const GRAPHQL = grammar([
	{ open: '#', close: '\n', keepClose: true },
	{ open: '"""', close: '"""' },
	{ open: '"', close: '"', escapes: true },
], false)

const TYPESCRIPT = grammar([
	{ open: '//', close: '\n', keepClose: true },
	{ open: '/*', close: '*/' },
	{ open: '"', close: '"', escapes: true },
	{ open: "'", close: "'", escapes: true },
	{ open: '`', close: '`', escapes: true },
], true)

/**
 * Blank out comments and string literals so the structural scan below can't be
 * fooled by a `{`, `#` or `}` inside them. Characters are replaced 1:1 with
 * spaces, never removed, so every offset in the cleaned text still addresses the
 * same character of the original (the selection bodies we slice out come from
 * the cleaned text, which is fine — we only ever read names from them).
 */
export function blankOutGraphqlLiterals(text: string): string {
	return blankOutLiterals(text, GRAPHQL)
}

/**
 * Blank out strings, template literals and comments so a `{` inside one can't
 * unbalance the brace matching. Characters are replaced 1:1, so every offset
 * still addresses the same character.
 */
export function blankOutTypeScriptLiterals(text: string): string {
	return blankOutLiterals(text, TYPESCRIPT)
}

function blankOutLiterals(text: string, { rules, keepNewlines }: LiteralGrammar): string {
	const out = text.split('')
	let i = 0
	while (i < text.length) {
		const rule = openerAt(text, i, rules)
		if (!rule) {
			i++
			continue
		}
		const stop = literalEnd(text, i + rule.open.length, rule)
		for (let k = i; k < Math.min(stop, text.length); k++) {
			if (!keepNewlines || text[k] !== '\n') out[k] = ' '
		}
		i = stop
	}
	return out.join('')
}

function openerAt(text: string, i: number, rules: Map<string, LiteralRule[]>): LiteralRule | undefined {
	const bucket = rules.get(text.charAt(i))
	if (!bucket) return undefined
	for (const rule of bucket) {
		if (text.startsWith(rule.open, i)) return rule
	}
	return undefined
}

/** Index just past the literal that started at `from`; the end of the text for an unterminated one. */
function literalEnd(text: string, from: number, rule: LiteralRule): number {
	let j = from
	while (j < text.length) {
		if (rule.escapes && text[j] === '\\') {
			j += 2
			continue
		}
		if (text.startsWith(rule.close, j)) return rule.keepClose ? j : j + rule.close.length
		j++
	}
	return text.length
}

export const NAME_START_RE = /[_A-Za-z]/
const NAME_RE = /[_0-9A-Za-z]/

/** Index of the next non-whitespace, non-comma character at or after `i`. */
export function skipTrivia(text: string, i: number): number {
	while (i < text.length && (/\s/.test(text[i] as string) || text[i] === ',')) i++
	return i
}

/** Skip any `@directive(...)` sequence at `i`, returning the index after it. */
export function skipDirectives(text: string, from: number): number {
	let i = skipTrivia(text, from)
	while (text[i] === '@') {
		const directive = readName(text, i + 1)
		i = skipTrivia(text, directive.next)
		if (text[i] === '(') i = skipTrivia(text, matchBlock(text, i, '(', ')'))
	}
	return i
}

/** Read a GraphQL name starting at `i`; returns the name and the index after it. */
export function readName(text: string, i: number): { name: string; next: number } {
	let j = i
	while (j < text.length && NAME_RE.test(text[j] as string)) j++
	return { name: text.slice(i, j), next: j }
}

/**
 * Index of the delimiter closing the block that opens at `i`, or `-1` when the
 * block is unterminated. Callers pick how to degrade — see {@link matchBlock}.
 */
export function findBlockEnd(text: string, i: number, open: string, close: string): number {
	let depth = 0
	for (let j = i; j < text.length; j++) {
		if (text[j] === open) depth++
		else if (text[j] === close) {
			depth--
			if (depth === 0) return j
		}
	}
	return -1
}

/**
 * Index just past the block that opens at `i` (`open`/`close` being its
 * delimiters). Returns `text.length` for an unterminated block — a truncated
 * document degrades to "fewer fields", never to a throw.
 */
export function matchBlock(text: string, i: number, open: string, close: string): number {
	const end = findBlockEnd(text, i, open, close)
	return end === -1 ? text.length : end + 1
}
