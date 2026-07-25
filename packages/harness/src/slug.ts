/**
 * Turn a human name into a safe, readable, lowercase filename stem (no
 * extension). Shared by the video-file namer (`context.ts`) and the auth cache
 * keyer (`auth.ts`) so there's one filename-safety contract, not two.
 *
 * Note: this is lossy by design (it strips diacritics and collapses runs of
 * non-alphanumerics), so distinct inputs CAN slug to the same stem. A caller that
 * needs a collision-free key must disambiguate the result itself (the video namer
 * appends `-2`/`-3`; the auth keyer appends a hash of the full name).
 */
export function slugify(name: string, fallback = 'item'): string {
	const slug = name
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug || fallback
}

/**
 * Disambiguate a filename stem against the ones already used, appending `-2`,
 * `-3`, … A scenario names its artifacts after itself, and two scenarios can
 * slug to the same stem ("Login" and "Login!", or two emoji-only names that both
 * fall back to "scenario") — without this the second would overwrite the first's
 * file. Callers pass their own `used` set: a scenario legitimately writes both a
 * `.webm` and a `.json` under the same stem, and one shared set would suffix the
 * second for no reason.
 */
export function uniqueStem(stem: string, used: Set<string>): string {
	let candidate = stem
	for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${n}`
	used.add(candidate)
	return candidate
}
