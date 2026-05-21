import { el, type ElementHandle, evalJs } from './element.js'

/**
 * Accessible-name selectors — `byRole` / `byLabel` / `byText`.
 *
 * opice prefers `data-testid` (see `el`), but real apps often can't be
 * annotated — third-party UIs, generated form-field ids, components you don't
 * own. agent-browser's own `find` locators look like the natural fit, but its
 * `find … click` dispatches a click that React/controlled-form components don't
 * reliably treat as a user gesture (a bindx submit button, for one, simply
 * doesn't fire). So we resolve the element ourselves: a small JS resolver runs
 * in the page, finds it by ARIA role + accessible name (or its `<label>`),
 * stamps it with a unique `data-opice-ref`, and the returned handle drives it
 * through `el()` — the same scroll-into-view + real-click + settle path as a
 * test-id selector. The resolver re-runs on every access, so a handle survives
 * client-side re-renders.
 *
 * Accessible name here is a pragmatic approximation (`aria-label` || text ||
 * value), not the full ARIA name computation — enough for buttons, links,
 * headings, and labelled form controls.
 */

let counter = 0

/** Page-side helpers injected before each finder expression. */
const HELPERS = `const __norm = s => (s||'').replace(/\\s+/g,' ').replace(/\\*/g,'').trim().toLowerCase();`
	+ `const __match = (text, want) => { const a = __norm(text), b = __norm(want); return a === b || (b.length > 0 && a.includes(b)); };`

/** agent-browser `eval` returns a JSON-encoded result; unwrap strings safely. */
function parseEval(raw: string): string {
	try {
		const value: unknown = JSON.parse(raw)
		return typeof value === 'string' ? value : String(value)
	} catch {
		return raw
	}
}

/**
 * Build an ElementHandle around a JS *expression* that evaluates to the target
 * `Element | null` in the page. Every handle method re-evaluates the
 * expression, (re-)stamps the match with a unique `data-opice-ref`, then
 * delegates to `el()` against that stamp — so the handle survives re-renders.
 */
function handleFor(nodeExpr: string, describe: string): ElementHandle {
	const ref = `opice-${++counter}`
	const target = `[data-opice-ref="${ref}"]`

	const resolve = (): boolean => {
		const result = parseEval(evalJs(
			`(() => {`
				+ `document.querySelectorAll('[data-opice-ref="${ref}"]').forEach(e => e.removeAttribute('data-opice-ref'));`
				+ HELPERS
				+ `const node = (${nodeExpr});`
				+ `if (!node) return 'NONE';`
				+ `node.setAttribute('data-opice-ref', '${ref}');`
				+ `return 'OK';`
				+ `})()`,
		))
		return result === 'OK'
	}

	const need = (op: string): void => {
		if (!resolve()) throw new Error(`${describe} not found (cannot ${op})`)
	}

	return {
		get exists(): boolean {
			return resolve() && el(target).exists
		},
		get text(): string {
			return resolve() ? el(target).text : ''
		},
		get value(): string {
			return resolve() ? el(target).value : ''
		},
		get isDisabled(): boolean {
			need('read disabled')
			return el(target).isDisabled
		},
		attr(name: string): string {
			return resolve() ? el(target).attr(name) : ''
		},
		count(): number {
			return resolve() ? el(target).count() : 0
		},
		click(): void {
			need('click')
			el(target).click()
		},
		fill(value: string): void {
			need('fill')
			el(target).fill(value)
		},
		select(optionText: string): void {
			need('select')
			el(target).select(optionText)
		},
		focus(): void {
			need('focus')
			el(target).focus()
		},
		hover(): void {
			need('hover')
			el(target).hover()
		},
		press(key: string): void {
			need('press')
			el(target).press(key)
		},
	}
}

/** CSS candidates per ARIA role. */
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

/**
 * Find an element by ARIA role and (optionally) its accessible name.
 * Accessible name is approximated as `aria-label` || text || value.
 */
export function byRole(role: string, name?: string): ElementHandle {
	const nodeExpr = `(() => {`
		+ `const __sel = ${JSON.stringify(roleSelector(role))};`
		+ `const __want = ${JSON.stringify(name ?? null)};`
		+ `const __accName = e => e.getAttribute('aria-label') || e.textContent || e.value || '';`
		+ `return Array.from(document.querySelectorAll(__sel)).find(e => __want == null ? true : __match(__accName(e), __want)) || null;`
		+ `})()`
	return handleFor(nodeExpr, `byRole(${role}${name ? `, ${JSON.stringify(name)}` : ''})`)
}

/**
 * Find a form control by its visible `<label>` text. Resolves the control via
 * `for`→id, a nested control, or the next control after the label.
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
	return handleFor(nodeExpr, `byLabel(${JSON.stringify(text)})`)
}

/** Find a leaf element by its visible text (first match). */
export function byText(text: string): ElementHandle {
	const nodeExpr = `(Array.from(document.querySelectorAll('body *')).find(e => e.children.length === 0 && __match(e.textContent, ${JSON.stringify(text)})) || null)`
	return handleFor(nodeExpr, `byText(${JSON.stringify(text)})`)
}
