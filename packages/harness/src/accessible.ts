import { exec, q } from './agent-browser.js'
import { el, type ElementHandle, evalJs } from './element.js'

/**
 * Accessible-name selectors — `byRole` / `byLabel` / `byText`.
 *
 * opice prefers `data-testid` (see `el`), but real apps often can't be
 * annotated — third-party UIs, generated form-field ids, components you don't
 * own. These wrap agent-browser's own `find` locators, so a test reads the same
 * way the authoring dry-run drives the page:
 *
 *     byRole('button', 'Save').click()   ⇄   agent-browser find role button click --name 'Save'
 *     byLabel('Email').fill('a@b.c')     ⇄   agent-browser find label 'Email' fill 'a@b.c'
 *
 * `find` covers actions only (click/fill/hover/check/…). Queries (`exists`,
 * `text`, …) and the focus/press path (Radix popovers open on focus+Enter, and
 * `find focus` is unreliable) fall back to a small `eval` against the same
 * accessible-name predicate. Accessible name is a pragmatic approximation
 * (`aria-label` || text || value), not the full ARIA computation.
 */

let counter = 0

/** Page-side helpers injected before each finder expression. */
const HELPERS = `const __norm = s => (s||'').replace(/\\s+/g,' ').replace(/\\*/g,'').trim().toLowerCase();`
	+ `const __match = (text, want) => { const a = __norm(text), b = __norm(want); return a === b || (b.length > 0 && a.includes(b)); };`

interface Locator {
	/** agent-browser `find` locator + value, e.g. `role button` or `label 'Email'`. */
	readonly findPart: string
	/** Options appended after the `find` action, e.g. ` --name 'Save'`. */
	readonly findOpts: string
	/** JS expression evaluating to the target `Element | null` in the page. */
	readonly nodeExpr: string
	readonly describe: string
}

function parseEval(raw: string): string {
	try {
		const value: unknown = JSON.parse(raw)
		return typeof value === 'string' ? value : String(value)
	} catch {
		return raw
	}
}

/** Evaluate `nodeExpr` and return whether it found an element. */
function probe(loc: Locator, expr: string): string {
	return parseEval(evalJs(`(() => { ${HELPERS} const node = (${loc.nodeExpr}); return (${expr}); })()`))
}

/** Stamp the matched element with a fresh `data-opice-ref` and return its selector. */
function stamp(loc: Locator): string {
	const ref = `opice-${++counter}`
	const ok = parseEval(evalJs(
		`(() => {`
			+ `document.querySelectorAll('[data-opice-ref="${ref}"]').forEach(e => e.removeAttribute('data-opice-ref'));`
			+ HELPERS
			+ `const node = (${loc.nodeExpr});`
			+ `if (!node) return 'NONE';`
			+ `node.setAttribute('data-opice-ref', '${ref}');`
			+ `return 'OK';`
			+ `})()`,
	))
	if (ok !== 'OK') throw new Error(`${loc.describe} not found`)
	return `[data-opice-ref="${ref}"]`
}

function handleFor(loc: Locator): ElementHandle {
	const find = (action: string, text?: string): void => {
		const textArg = text === undefined ? '' : ` ${q(text)}`
		exec(`agent-browser find ${loc.findPart} ${action}${textArg}${loc.findOpts}`)
	}
	return {
		// Queries — small eval against the accessible-name predicate.
		get exists(): boolean {
			return probe(loc, '!!node') === 'true'
		},
		get text(): string {
			return probe(loc, "node ? (node.textContent||'') : ''")
		},
		get value(): string {
			return probe(loc, "node ? (node.value||'') : ''")
		},
		get isDisabled(): boolean {
			return probe(loc, '!!(node && (node.disabled || node.getAttribute(\'aria-disabled\') === \'true\'))') === 'true'
		},
		attr(name: string): string {
			return probe(loc, `node ? (node.getAttribute(${JSON.stringify(name)})||'') : ''`)
		},
		// Accessible handles target a single element (the first match). For real
		// counts use `el('css').count()`.
		count(): number {
			return probe(loc, '!!node') === 'true' ? 1 : 0
		},
		// Actions — agent-browser `find` passthrough (mirrors the authoring dry-run).
		click(): void {
			find('click')
		},
		fill(value: string): void {
			find('fill', value)
		},
		select(optionText: string): void {
			el(stamp(loc)).select(optionText)
		},
		focus(): void {
			el(stamp(loc)).focus()
		},
		hover(): void {
			find('hover')
		},
		press(key: string): void {
			el(stamp(loc)).press(key)
		},
	}
}

/**
 * Find an element by ARIA role and (optionally) its accessible name.
 * `byRole('button', 'Save').click()` → `agent-browser find role button click --name 'Save'`.
 */
export function byRole(role: string, name?: string): ElementHandle {
	const sel = roleSelector(role)
	const nodeExpr = `(() => {`
		+ `const __sel = ${JSON.stringify(sel)};`
		+ `const __want = ${JSON.stringify(name ?? null)};`
		+ `const __accName = e => e.getAttribute('aria-label') || e.textContent || e.value || '';`
		+ `return Array.from(document.querySelectorAll(__sel)).find(e => __want == null ? true : __match(__accName(e), __want)) || null;`
		+ `})()`
	return handleFor({
		findPart: `role ${role}`,
		findOpts: name === undefined ? '' : ` --name ${q(name)}`,
		nodeExpr,
		describe: `byRole(${role}${name ? `, ${JSON.stringify(name)}` : ''})`,
	})
}

/**
 * Find a form control by its visible `<label>` text (resolved via `for`→id, a
 * nested control, or the next control after the label).
 * `byLabel('Email').fill('x')` → `agent-browser find label 'Email' fill 'x'`.
 */
export function byLabel(text: string): ElementHandle {
	const controls = 'input,textarea,select,button,[role=textbox],[role=combobox]'
	const nodeExpr = `(() => {`
		+ `const __want = ${JSON.stringify(text)};`
		+ `const __label = Array.from(document.querySelectorAll('label')).find(l => __match(l.textContent, __want));`
		+ `if (!__label) return null;`
		+ `const __id = __label.getAttribute('for');`
		+ `if (__id) { const c = document.getElementById(__id); if (c) return c; }`
		+ `const __nested = __label.querySelector(${JSON.stringify(controls)}); if (__nested) return __nested;`
		+ `let __n = __label.nextElementSibling;`
		+ `while (__n) {`
		+ `if (__n.matches && __n.matches(${JSON.stringify(controls)})) return __n;`
		+ `const __inner = __n.querySelector && __n.querySelector(${JSON.stringify(controls)}); if (__inner) return __inner;`
		+ `__n = __n.nextElementSibling;`
		+ `}`
		+ `return null;`
		+ `})()`
	return handleFor({
		findPart: `label ${q(text)}`,
		findOpts: '',
		nodeExpr,
		describe: `byLabel(${JSON.stringify(text)})`,
	})
}

/**
 * Find a leaf element by its visible text.
 * `byText('Saved').exists` / `byText('Continue').click()`.
 */
export function byText(text: string): ElementHandle {
	const nodeExpr = `(Array.from(document.querySelectorAll('body *')).find(e => e.children.length === 0 && __match(e.textContent, ${JSON.stringify(text)})) || null)`
	return handleFor({
		findPart: `text ${q(text)}`,
		findOpts: '',
		nodeExpr,
		describe: `byText(${JSON.stringify(text)})`,
	})
}

/** CSS candidates per ARIA role (for the query/focus fallback predicate). */
function roleSelector(role: string): string {
	switch (role) {
		case 'button':
			return 'button,[role=button]'
		case 'link':
			return 'a[href],[role=link]'
		case 'textbox':
			return 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]),textarea,[role=textbox],[contenteditable=true]'
		case 'checkbox':
			return 'input[type=checkbox],[role=checkbox]'
		case 'combobox':
			return 'select,[role=combobox]'
		case 'heading':
			return 'h1,h2,h3,h4,h5,h6,[role=heading]'
		case 'option':
			return 'option,[role=option]'
		case 'tab':
			return '[role=tab]'
		default:
			return `[role=${role}]`
	}
}
