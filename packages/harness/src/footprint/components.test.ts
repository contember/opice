import { describe, expect, test } from 'bun:test'
import { COMPONENT_BINDING, COMPONENT_SCRIPT } from './components'

/**
 * Run the injected script against a stand-in `window` and a fake DevTools hook,
 * so its behaviour can be exercised without a browser. Returns the component
 * names it reported.
 */
function collectFrom(roots: string[]): string[] {
	const names: string[] = []
	const win: Record<string, unknown> = {
		[COMPONENT_BINDING]: (payload: { names?: string[] } | string[]) => {
			names.push(...(Array.isArray(payload) ? payload : payload?.names ?? []))
		},
		addEventListener() {},
	}
	const fakeTimeout = (fn: () => void) => { queueMicrotask(fn); return 0 }
	new Function('window', 'setTimeout', 'Date', COMPONENT_SCRIPT)(win, fakeTimeout, Date)
	const hook = win['__REACT_DEVTOOLS_GLOBAL_HOOK__'] as {
		inject(r: unknown): number
		onCommitFiberRoot(id: number, root: unknown): void
	}
	hook.inject({})
	for (const name of roots) {
		hook.onCommitFiberRoot(1, {
			current: { elementType: { displayName: name }, type: null, child: null, sibling: null, return: null },
		})
	}
	;(win['__opiceFootprintSweep'] as () => void)()
	return [...new Set(names)].sort()
}

describe('component collection', () => {
	test('reports a single root', () => {
		expect(collectFrom(['AppRoot'])).toEqual(['AppRoot'])
	})

	// An app can mount several independent React roots — a widget, a portal, a
	// legacy island. Keeping only the newest meant the others were never walked,
	// their components missing while the dimension still read as complete.
	test('reports every root committed inside one throttle window', () => {
		expect(collectFrom(['WidgetRoot', 'AppRoot'])).toEqual(['AppRoot', 'WidgetRoot'])
	})

	test('reports many roots', () => {
		expect(collectFrom(['A', 'B', 'C', 'D'])).toEqual(['A', 'B', 'C', 'D'])
	})

	test('the injected script parses', () => {
		expect(() => new Function(COMPONENT_SCRIPT)).not.toThrow()
	})
})
