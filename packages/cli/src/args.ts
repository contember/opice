/**
 * Argument parsing shared by opice's commands.
 *
 * These flags are opice's own, not bun's, so `opice test` has to strip them
 * before handing the remainder to `bun test` — which is why every extractor
 * returns the leftover args alongside the value. `opice impact` has nothing to
 * pass on, but it uses the same functions so that a flag spelled the same way in
 * two commands is also *parsed* the same way.
 */

/**
 * Pull an optional-value flag (`--name` / `--name=value`) out of the arg list.
 *
 * The `--name=value` form always sets the value. The bare `--name value` form
 * only consumes the following token when `isValue(token)` says it's a value and
 * not a passthrough (a leading `-`, or a bun test-file/name arg). Omit `isValue`
 * to make bare `--name` NEVER consume the next token — the safe default when a
 * value is indistinguishable from a bun positional (use the `=` form for those).
 */
export function extractOptionalValueFlag(
	args: string[],
	name: string,
	isValue?: (token: string) => boolean,
): { present: boolean; value: string | undefined; rest: string[] } {
	const rest: string[] = []
	const eq = `--${name}=`
	let present = false
	let value: string | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith(eq)) {
			present = true
			value = arg.slice(eq.length) || undefined
		} else if (arg === `--${name}`) {
			present = true
			const next = args[i + 1]
			if (isValue && next !== undefined && !next.startsWith('-') && isValue(next)) {
				value = next
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	return { present, value, rest }
}

/**
 * Pull a repeatable, comma-splittable flag (`--name=a,b --name c`) out of the
 * arg list, returning every entry. Used by `--select` and `--model`.
 */
export function extractList(args: string[], name: string): { values: string[]; rest: string[] } {
	const rest: string[] = []
	const entries: string[] = []
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith(`--${name}=`)) {
			entries.push(arg.slice(name.length + 3))
		} else if (arg === `--${name}`) {
			const next = args[i + 1]
			if (next !== undefined && !next.startsWith('-')) {
				entries.push(next)
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	const values = entries
		.flatMap((entry) => entry.split(','))
		.map((entry) => entry.trim())
		.filter(Boolean)
	return { values, rest }
}

/** Pull a boolean flag out of the arg list. */
export function extractBoolean(args: string[], name: string): { present: boolean; rest: string[] } {
	const rest: string[] = []
	let present = false
	for (const arg of args) {
		if (arg === `--${name}`) present = true
		else rest.push(arg)
	}
	return { present, rest }
}

/**
 * Pull a non-negative integer flag (`--name=N` / `--name N`). An invalid value
 * is ignored so the caller falls through to its config default.
 */
export function extractInteger(args: string[], name: string): { value: number | undefined; rest: string[] } {
	const rest: string[] = []
	let value: number | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith(`--${name}=`)) {
			const n = Number(arg.slice(name.length + 3))
			if (Number.isInteger(n) && n >= 0) value = n
		} else if (arg === `--${name}`) {
			const n = Number(args[i + 1])
			if (Number.isInteger(n) && n >= 0) {
				value = n
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	return { value, rest }
}

/** Pull a plain string flag (`--name=V` / `--name V`) out of the arg list. */
export function extractValue(args: string[], name: string): { value: string | undefined; rest: string[] } {
	const rest: string[] = []
	let value: string | undefined
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === undefined) continue
		if (arg.startsWith(`--${name}=`)) {
			value = arg.slice(name.length + 3)
		} else if (arg === `--${name}`) {
			const next = args[i + 1]
			if (next !== undefined) {
				value = next
				i++ // consume the value
			}
		} else {
			rest.push(arg)
		}
	}
	return { value, rest }
}
