import { exec, q } from './agent-browser.js'

const POLL_INTERVAL = 200
const POLL_TIMEOUT = 10_000
const ACTION_SETTLE_MS = 500

/**
 * Auto-wrap bare identifiers as `[data-testid="…"]` selectors; treat anything
 * with CSS-flavoured characters as a raw selector. Heuristic — if you need a
 * plain-tag selector (e.g. `h1`), give it some structure (e.g. `main h1`) or
 * use a descendant/attribute form.
 */
function resolveSelector(selectorOrTestId: string): string {
	if (/[\[\].#:> ]/.test(selectorOrTestId)) {
		return selectorOrTestId
	}
	return `[data-testid="${selectorOrTestId}"]`
}

/**
 * Poll a condition until it returns true or timeout.
 * Use instead of fixed sleep — stable on both fast local and slow CI.
 */
export function waitFor(
	condition: () => boolean,
	{ timeout = POLL_TIMEOUT, interval = POLL_INTERVAL, message }: { timeout?: number; interval?: number; message?: string } = {},
): void {
	const start = Date.now()
	while (Date.now() - start < timeout) {
		try {
			if (condition()) return
		} catch {
			// condition threw — treat as not yet ready
		}
		Bun.sleepSync(interval)
	}
	if (!condition()) {
		const elapsed = Date.now() - start
		const hint = message ?? condition.toString().slice(0, 120)
		throw new Error(`waitFor timed out after ${elapsed}ms: ${hint}`)
	}
}

export interface ElementHandle {
	readonly exists: boolean
	readonly text: string
	readonly value: string
	readonly isDisabled: boolean
	attr(name: string): string
	count(): number
	click(): void
	fill(value: string): void
	select(optionText: string): void
}

export function el(selector: string): ElementHandle {
	const sel = resolveSelector(selector)
	const quoted = q(sel)
	return {
		get exists(): boolean {
			return parseInt(exec(`agent-browser get count ${quoted}`), 10) > 0
		},
		get text(): string {
			return exec(`agent-browser get text ${quoted}`)
		},
		get value(): string {
			return exec(`agent-browser get value ${quoted}`)
		},
		get isDisabled(): boolean {
			return exec(`agent-browser is enabled ${quoted}`) !== 'true'
		},
		attr(name: string): string {
			return exec(`agent-browser get attr ${name} ${quoted}`)
		},
		count(): number {
			return parseInt(exec(`agent-browser get count ${quoted}`), 10) || 0
		},
		click(): void {
			exec(`agent-browser scrollintoview ${quoted}`)
			exec(`agent-browser click ${quoted}`)
			Bun.sleepSync(ACTION_SETTLE_MS)
		},
		fill(value: string): void {
			exec(`agent-browser scrollintoview ${quoted}`)
			exec(`agent-browser fill ${quoted} ${q(value)}`)
			Bun.sleepSync(ACTION_SETTLE_MS)
		},
		select(optionText: string): void {
			exec(`agent-browser scrollintoview ${quoted}`)
			exec(`agent-browser select ${quoted} ${q(optionText)}`)
			Bun.sleepSync(ACTION_SETTLE_MS)
		},
	}
}

/**
 * Build a `[data-testid="..."]` selector for compound selectors.
 * Usage: el(`${tid('parent')} button`)
 */
export function tid(testId: string): string {
	return `[data-testid="${testId}"]`
}

export function wait(ms: number): void {
	Bun.sleepSync(ms)
}

export function evalJs(js: string): string {
	return exec(`agent-browser eval ${q(js)}`)
}

export function screenshot(path?: string): string {
	const target = path ?? `/tmp/opice-screenshot-${Date.now()}.png`
	exec(`agent-browser screenshot ${target}`)
	return target
}
