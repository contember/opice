/**
 * GraphQL request → operations → data models.
 *
 * A footprint's most useful dimension for a full-stack repo isn't the URL — every
 * GraphQL call hits the same `/graphql` — it's *which entities* the scenario read
 * and wrote. That is recoverable from the request body alone: the operation type
 * and the top-level fields of its selection set.
 *
 * This parses only as far as it needs to. There is no dependency on the `graphql`
 * package: pulling a full parser (and its schema machinery) into the *test
 * runtime* to read the first level of a selection set would be absurd. What is
 * needed is a tolerant scanner that survives comments, strings, aliases,
 * variables, directives and fragments — everything below does exactly that and
 * nothing more.
 *
 * **Only names are extracted.** Variables are never read: `variables` is where
 * the passwords, tokens and personal data live, and a footprint is rendered on a
 * dashboard.
 *
 * This file is the module's public surface; the stages live in `graphql/`:
 * `extract` (request body → documents), `scan` (character-level primitives),
 * `parse` (document → operations) and `models` (operations → entities).
 */

export { extractQueries, looksLikeGraphql, type ExtractedQueries } from './graphql/extract.js'
export { deriveModels, toFootprintOperation, type ModelDerivation } from './graphql/models.js'
export {
	parseArgumentKeys,
	parseOperations,
	type GqlFieldNode,
	type ParsedOperation,
	type ParseOptions,
} from './graphql/parse.js'
