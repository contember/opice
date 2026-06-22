/**
 * Shared env helpers. A leaf module (no imports) so any harness file can use it
 * without pulling in the reporter's import-time side effects.
 */

/** Whether an env var reads as "on" — `1` / `true` / `yes` / `on` (case-insensitive). */
export function isTruthy(value: string | undefined): boolean {
	if (!value) return false
	const v = value.toLowerCase()
	return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}
