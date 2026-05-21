import { command, z, type Command, type CommandCtx } from '@opice/harness'
import type { Locator } from 'playwright'

/**
 * Built-in browser verbs for the authoring CLI, defined with the same
 * `command()` primitive a repo's `browser-tools.ts` uses. The agent drives the
 * app through these during the dry-run; the test it writes uses the matching
 * harness DSL — same vocabulary, same Playwright backing.
 */

/** Apply an action to a resolved locator (shared by byRole/byLabel/byText). */
async function applyAction(
	locator: Locator,
	action: string,
	opts: { value?: string; key?: string },
): Promise<unknown> {
	switch (action) {
		case 'click':
			return locator.click()
		case 'fill':
			return locator.fill(opts.value ?? '')
		case 'focus':
			return locator.focus()
		case 'hover':
			return locator.hover()
		case 'press':
			return locator.press(opts.key ?? 'Enter')
		case 'text':
			return locator.textContent()
		case 'count':
			return locator.count()
		default:
			throw new Error(`Unknown action "${action}" (click|fill|focus|hover|press|text|count)`)
	}
}

const actionFields = {
	action: z.string().default('click'),
	value: z.string().optional(),
	key: z.string().optional(),
}

export const builtins: Command[] = [
	command('open', z.object({ url: z.string() }), async ({ page }, { url }) => {
		await page.goto(url)
		return page.url()
	}, 'Navigate to a URL'),

	command('reload', z.object({}), async ({ page }) => {
		await page.reload()
		return page.url()
	}, 'Reload the current page'),

	command('back', z.object({}), async ({ page }) => {
		await page.goBack()
		return page.url()
	}, 'Go back in history'),

	command('forward', z.object({}), async ({ page }) => {
		await page.goForward()
		return page.url()
	}, 'Go forward in history'),

	command('click', z.object({ selector: z.string() }), async ({ el }, { selector }) => {
		await el(selector).click()
	}, 'Click an element (test-id or CSS selector)'),

	command('fill', z.object({ selector: z.string(), value: z.string() }), async ({ el }, { selector, value }) => {
		await el(selector).fill(value)
	}, 'Fill an input/textarea'),

	command('press', z.object({ key: z.string(), selector: z.string().optional() }), async ({ el, page }, { key, selector }) => {
		if (selector) await el(selector).press(key)
		else await page.keyboard.press(key)
	}, 'Press a key (optionally focusing a selector first)'),

	command('hover', z.object({ selector: z.string() }), async ({ el }, { selector }) => {
		await el(selector).hover()
	}, 'Hover an element'),

	command('text', z.object({ selector: z.string() }), async ({ el }, { selector }) => {
		return el(selector).textContent()
	}, 'Read an element\'s textContent'),

	command('value', z.object({ selector: z.string() }), async ({ el }, { selector }) => {
		return el(selector).inputValue()
	}, 'Read an input\'s value'),

	command('count', z.object({ selector: z.string() }), async ({ el }, { selector }) => {
		return el(selector).count()
	}, 'Count elements matching a selector'),

	command('byRole', z.object({ role: z.string(), name: z.string().optional(), ...actionFields }), async (ctx, { role, name, action, value, key }) => {
		return applyAction(ctx.byRole(role as Parameters<CommandCtx['byRole']>[0], name), action, { value, key })
	}, 'Resolve by ARIA role (+optional --name) and run --action (default click)'),

	command('byLabel', z.object({ label: z.string(), ...actionFields }), async (ctx, { label, action, value, key }) => {
		return applyAction(ctx.byLabel(label), action, { value, key })
	}, 'Resolve a form control by its <label> and run --action'),

	command('byText', z.object({ text: z.string(), ...actionFields }), async (ctx, { text, action, value, key }) => {
		return applyAction(ctx.byText(text), action, { value, key })
	}, 'Resolve by visible text and run --action'),

	command('aria-snapshot', z.object({ selector: z.string().optional() }), async ({ page }, { selector }) => {
		const root = selector ? page.locator(selector) : page.locator('body')
		return root.ariaSnapshot()
	}, 'Print the ARIA accessibility tree (YAML) — the agent\'s view of the page'),

	command('screenshot', z.object({ path: z.string().optional() }), async ({ page }, { path }) => {
		const target = path ?? `/tmp/opice-browser-${Date.now()}.png`
		await page.screenshot({ path: target })
		return target
	}, 'Capture a screenshot'),

	command('title', z.object({}), async ({ page }) => page.title(), 'Read the document title'),

	command('url', z.object({}), async ({ page }) => page.url(), 'Read the current URL'),

	command('eval', z.object({ js: z.string() }), async ({ page }, { js }) => page.evaluate(js), 'Evaluate JS in the page'),
]

/**
 * Positional-argument hints for built-ins, so the ergonomic
 * `opice-browser click add` works alongside `--selector add`. User verbs from
 * browser-tools.ts are flag-only.
 */
export const positionalHints: Record<string, string[]> = {
	open: ['url'],
	click: ['selector'],
	fill: ['selector', 'value'],
	press: ['key'],
	hover: ['selector'],
	text: ['selector'],
	value: ['selector'],
	count: ['selector'],
	byRole: ['role', 'action'],
	byLabel: ['label', 'action'],
	byText: ['text', 'action'],
	'aria-snapshot': ['selector'],
	eval: ['js'],
}
