/**
 * Contember conventions, as a plugin.
 *
 * These four rules used to be module constants inside the GraphQL parser, which
 * meant a repo could neither remove one nor add its own — the only escape hatch
 * was `mapOperation`, which replaces the *whole* derivation. Nothing about them
 * changed in moving here; they are simply now removable, greppable by name, and
 * a template for the next framework's set.
 *
 * Ships in `defaultPlugins`, so a repo that configures nothing gets exactly what
 * it got before.
 */

import type { FootprintPlugin } from './types.js'

/**
 * Contember's content API exposes `validateCreateArticle` / `validateUpdateArticle`
 * on the *Query* root: a dry run that checks an input against the entity's rules
 * without writing. Read naively that parses as the verb `validate` applied to an
 * entity called `CreateArticle`, which is not a thing. Stripping the prefix
 * recovers the real entity — and it stays a READ, because validating is exactly
 * the operation that promises not to write.
 */
const VALIDATE_RE = /^validate(?:Create|Update|Upsert|Delete)([A-Z][A-Za-z0-9_]*)$/

export function contember(): FootprintPlugin {
	return {
		name: 'contember',
		dimensions: ['models'],
		graphql: {
			// Contember wraps every mutation in `transaction { … }`, so without
			// unwrapping, every write in a Contember app would report one model
			// called "transaction".
			transparentFields: ['transaction'],
			// Mutation-result and meta fields — never entities.
			ignoredRootFields: ['_info', 'ok', 'errorMessage'],
		},
		bind: () => ({
			model: (field) => {
				const entity = VALIDATE_RE.exec(field.name)?.[1]
				// `undefined`, not `null`: a field this rule doesn't recognise is for the
				// verb heuristic to read, not for this plugin to veto.
				return entity ? { name: entity, write: false } : undefined
			},
		}),
	}
}
