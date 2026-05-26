import type { Locator, Page } from 'playwright'
import { getPage } from './context.js'

/** The ARIA role union accepted by Playwright's `getByRole`. */
type Role = Parameters<Page['getByRole']>[0]
/** Playwright's `getByRole` options minus `name` (which is passed positionally). */
type RoleOptions = Omit<NonNullable<Parameters<Page['getByRole']>[1]>, 'name'>

/**
 * Accessible-name selectors — `byRole` / `byLabel` / `byText`.
 *
 * opice prefers `data-testid` (see `el`), but real apps often can't be
 * annotated — third-party UIs, generated form-field ids, components you don't
 * own. These map straight onto Playwright's accessibility-aware locators, which
 * compute the real ARIA accessible name and fire real user gestures. No
 * in-page resolver, no stamping — the previous engine (agent-browser) was
 * CSS-only and couldn't do this, which is a large part of why opice moved to
 * Playwright.
 *
 * All three return a `Locator`, so the full Locator API and `expect(locator)`
 * assertions apply.
 */

/**
 * Find an element by ARIA role and (optionally) its accessible name.
 * `name` does a substring, case-insensitive match when a string; pass a
 * `RegExp` to match the accessible name by pattern (e.g. a generated id).
 *
 * `options` forwards the rest of Playwright's `getByRole` filters — most useful
 * is `level` to pin a heading (`byRole('heading', 'Title', { level: 2 })`), plus
 * `exact`, `checked`, `pressed`, `expanded`, `disabled`, etc.
 */
export function byRole(role: Role, name?: string | RegExp, options?: RoleOptions): Locator {
	const opts = { ...options, ...(name == null ? {} : { name }) }
	return getPage().getByRole(role, Object.keys(opts).length > 0 ? opts : undefined)
}

/** Find a form control by its associated `<label>` (or `aria-label`) text. */
export function byLabel(text: string): Locator {
	return getPage().getByLabel(text)
}

/** Find an element by its visible text (substring, case-insensitive). */
export function byText(text: string): Locator {
	return getPage().getByText(text)
}
