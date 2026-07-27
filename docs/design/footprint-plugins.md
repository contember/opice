# Design: footprint plugins

**Status:** implemented, all four steps of §8, verified against a real Contember
repo (304 entities, 330 GraphQL documents — §12). §11 records where the build
deviated from this design.
**Author:** drafted with Claude.
**Scope:** `@opice/harness` footprint collection (`src/footprint/`). The wire
contract with the platform (edge kinds, `collected`, `partial`) is deliberately
**unchanged** — see §3.

---

## 1. The principle

A footprint answers one question: **what does this scenario depend on?** Every
collector is a variation on the same move — observe something the browser did,
map it to a dependency.

That abstraction is already in the code twice, unnamed:

- the **modules** collector takes an HTTP request and returns a source file (a
  dev server's ES-module URL *is* the path);
- the **graphql** collector takes an HTTP request and returns a dependency it
  cannot name as a file, so it names it as an entity instead.

Naming it changes what the extension point should be. Not "a hook inside the
GraphQL parser", but **an HTTP request → dependencies**, with GraphQL as one
interpretation layer that some plugins choose to work at.

The clearest demonstration that this generalizes past GraphQL: a file-routed
backend. `POST /api/invoices/:id` maps to `app/routes/api.invoices.$id.ts` in
Remix / React Router, `pages/api/invoices/[id].ts` in Next. That is a
twenty-line plugin, and it turns an inert `endpoint` edge into a real file
dependency — `--impacted` starts selecting on backend route changes, which today
it cannot do at all.

### 1.1 Two sharpenings

**Files are the goal, not always reachable.** The browser cannot name the source
file behind an entity unless a plugin knows the repo's layout. So a dependency is
**a path when knowable, a symbol otherwise**, and a plugin's job is to move as
much as it can from the second to the first. This demotes `models` and
`endpoints` from peer dimensions to *fallbacks* — which is what they already are
in practice: the worker matches a changed `api/model/Company.ts` against the
model edge `Company` by basename (`matchEdge` in `worker/src/footprint.ts`). A
plugin that emits the path outright removes that guess from the platform.

**Not everything is a request.** V8 coverage and the React fiber walk are
page-level measurements, not request handlers. They stay built-in, because they
need access to the page — and handing a plugin the page is exactly what would
turn the leak invariant (§7.2) from a type into a promise. Plugins receive the
derived stream.

## 2. Why now

### 2.1 Conventions are constants in the parser

Framework rules live as module constants in `footprint/graphql.ts`:
`DEFAULT_TRANSPARENT_FIELDS` (`transaction`), `VALIDATE_RE`
(`validateCreateX`), `IGNORED_ROOT_FIELDS` (`_info`, `ok`, `errorMessage`),
`READ_VERBS`/`WRITE_VERBS`. Only the first is reachable from config. The single
escape hatch, `mapOperation`, replaces the *whole* derivation — there is no way
to drop one rule, add one convention, or package a second framework's rules for
distribution.

### 2.2 The parser sees only the top level

Measured against the real parser:

```
query InjuryDetail { getInjury(by: {id: $id}) { account { company { name } } correctiveActions { state } } }
  → rootFields ["getInjury"]   models [{ Injury, write: false }]

query ListInjury { listInjury(filter: { account: { company: { name: { eq: "acme" } } } }) { id } }
  → rootFields ["listInjury"]  models [{ Injury, write: false }]
```

`Account`, `Company` and `CorrectiveAction` are invisible — as relations in the
selection set, and as relation names inside a filter argument. `rootFieldsOf`
keeps the top level and discards the rest; arguments are skipped as a block.

For change tracking that is the whole ballgame: edit `api/model/Company.ts`, the
impact query looks for a model edge named `Company`, finds none, and does not
select the scenario that renders company names. What partially covers this today
is the file dimension — a Contember admin bundles `api/model/*.ts`, so coverage
sees them — but only in `full` mode, only when the file is actually *called*, and
not at all for a backend-only change.

The fix is not "also walk the children". A nested field name is not an entity
name: `account` → `Account` survives capitalization, `correctiveActions` →
`CorrectiveAction` needs singularization, `createdBy` → `Author` is unknowable
without the schema. A built-in walking the tree would invent entities. **The
parser should report the tree faithfully and let something that knows the schema
resolve it** — which is not expressible as a table of strings, and is why §1's
framing and §2's gap have the same answer.

## 3. Open interface, closed vocabulary

The one call that keeps this safe. Plugins are open — anyone can write one, they
compose, they hold state. The **dimension vocabulary is closed**:
`files | components | endpoints | models`.

That vocabulary is the wire contract with the index. `indexableKinds` on the
worker decides, per dimension, whether a run is entitled to *replace* what is
already there — the machinery that stops a degraded run from silently narrowing
CI. A plugin declares which of the four it contributes to and how completely; it
cannot invent a fifth. A fifth dimension is a migration and a release,
deliberately.

Concretely: `footprint_edges` is already `(kind, value)`, which *is* a dependency
record. So this whole design is a harness-side refactor — the platform sees the
same edges, some of them just newly say `file` where they used to say `model`.

## 4. The interface

A plugin binds once per scenario and answers with hooks. Binding per scenario is
what lets it hold state: accumulate what it has seen, resolve a name it learns
about later, read the repo's schema once and close over it.

```ts
export interface FootprintPlugin {
	name: string
	/**
	 * Dimensions this plugin contributes to. Bounds the blast radius: if `bind`
	 * throws we don't know what it would have produced, and these are the
	 * dimensions marked partial. Omitted → all four.
	 */
	dimensions?: FootprintDimension[]
	bind(context: PluginContext): FootprintHooks | Promise<FootprintHooks>
}

/** Metadata only — no page, no browser context, no raw request. See §7.2. */
export interface PluginContext {
	scenario: string
	testFile?: string
	baseUrl?: string
	mode: 'network' | 'full'
}
```

Plugins also contribute **conventions** — data the GraphQL *parser* needs
(`transparentFields`, `ignoredRootFields`, extra verbs). Data rather than hooks
because the parser runs before any hook could see anything, and **unioned**
across plugins rather than overridden: two plugins both naming a transparent
wrapper is the normal case, and "last one wins" would disarm the first.

```ts
export interface FootprintHooks {
	/** Resolver: what does this request depend on? Runs once per request after the scenario ends. */
	resolve?(request: RequestObservation, context: PluginContext): Dependency[] | undefined
	/** One top-level field → the model it names. `null` = definitively not a model. */
	model?(field: GqlFieldNode, context: FieldContext): FootprintModel | null | undefined
	/** Raw URL → route template (a string, sanitized like `normalizeUrl`'s). `null` drops the request. */
	route?(url: string, context: PluginContext): string | null | undefined
	/** One path segment → collapse to `:id`? Only `true` is meaningful. */
	segment?(segment: string, context: SegmentContext): boolean | undefined
	/** A module / source-map path → repo-relative path, or `null` to drop. */
	file?(path: string, context: PluginContext): string | null | undefined
	/** A component name off the fiber walk → cleaned (`withRouter(Foo)` → `Foo`), or `null`. */
	component?(name: string, context: PluginContext): string | null | undefined
}

/** A dependency: a path when knowable, a symbol when not. */
export type Dependency =
	| { kind: 'file'; path: string }
	| { kind: 'component'; name: string }
	| { kind: 'model'; name: string; write?: boolean }

/** What a plugin sees of a request. Derived data only — never the body, headers or cookies. */
export interface RequestObservation {
	method: string
	/** Templated route, origin-qualified when cross-origin. */
	route: string
	/** Query parameter NAMES only. */
	params?: string[]
	status: number | null
	resourceType: string
	/** 0-based index of the active step, or null. */
	step: number | null
	/** Whatever interpreters attached — `graphql.operations` and the like. */
	interpreted: Readonly<Record<string, unknown>>
}
```

Every hook returns `undefined` to mean **"not mine, try the next plugin"**.
Chain order is: the repo's own hooks, then plugins in declaration order, then the
built-in rule for that seam.

## 5. The GraphQL layer

GraphQL parsing stays built in — §3 keeps `collected` a fixed vocabulary, and a
plugin that could switch off parsing would be switching off a whole dimension.
What plugs in is everything *above* the parse: the conventions it reads by, and
the rules that turn its output into entities.

§2.2 is fixed by what the parser now produces:

```ts
export interface ParsedOperation {
	type: 'query' | 'mutation' | 'subscription'
	name?: string
	/** Unchanged: top-level field names, transparent wrappers unwrapped. */
	rootFields: string[]
	/**
	 * The selection tree, depth-capped. New — and deliberately NOT stored in the
	 * footprint. Its only consumer is a plugin's `resolve` hook, which runs here
	 * during collection; a stored tree would be 500 nodes times 2000 requests, and
	 * neither the dashboard nor the index has any use for it.
	 */
	fields?: GqlFieldNode[]
	/** A cap was hit while building it, so it is a sample. Marks `models` partial. */
	truncated?: boolean
}

export interface GqlFieldNode {
	/** Field name, alias already resolved. */
	name: string
	/** Path from the operation root: ['getInjury', 'account', 'company']. */
	path: string[]
	/**
	 * Argument object KEY PATHS, names only — ['by.id', 'filter.account.company.name.eq'].
	 * A filter's keys are relation names, which is the dependency signal §2.2 loses.
	 */
	args?: string[]
	children?: GqlFieldNode[]
}
```

### 5.1 Names only — no values, at any depth

`filter: { account: { company: { name: { eq: 'acme' } } } }` yields the key path
`filter.account.company.name.eq` and **never** `'acme'`. Absolute, not a
judgement call per argument: the footprint is uploaded and rendered on a
dashboard, filters carry emails, search terms and tenant names, and "this
particular literal looks harmless" is how the first one gets through. A variable
reference is recorded as the fact that the argument is a variable; the
`variables` JSON is never read at all.

Same rule query strings already follow, and it wants the same test: parse a
document carrying an email, an API key and a variable reference, assert none of
them appear anywhere in the footprint.

### 5.2 Caps

The tree is bounded — max depth, max nodes per operation — because a deep
document times 2000 requests is a real blob-size risk. Hitting either cap marks
`models` **partial**, exactly like a truncated request stream: a sampled tree is
not a tree, and the index must not replace a fuller run's edges from one.

### 5.3 What the built-in resolver does with the tree

**Nothing, by default.** The built-in verb+Entity rule keeps working off
`rootFields`; capitalize-and-singularize over the tree would invent entities.

One caveat worth deciding rather than inheriting: the principle "a wrong model is
worse than a missing one" was written for the dashboard, and change tracking
pulls the other way. For *selection*, over-matching is the safe failure direction
— `--impacted` only ever adds, a spurious edge costs one scenario that didn't
need to run, a missing edge costs a regression nobody catches. So an approximate
tree derivation is worth more to the index than to the dashboard. Options in §10.

### 5.4 The plugins above it

```ts
// Conventions, as data — the declarative helper returns an ordinary plugin.
export function contember(): FootprintPlugin {
	return rules('contember', {
		transparentFields: ['transaction'],
		ignoredRootFields: ['_info', 'ok', 'errorMessage'],
		models: [validateRule],   // same VALIDATE_RE, now removable and greppable
	})
}

// The thing that actually closes §2.2 — and emits FILES, not symbols.
export function contemberSchema(modelDir = 'api/model'): FootprintPlugin {
	return {
		name: 'contember-schema',
		dimensions: ['models', 'files'],
		async bind() {
			// Read the repo's own schema once: entity names, and per entity its
			// relation field → target entity. Ordinary node code in the user's repo —
			// opice hands it nothing.
			const schema = await readEntityGraph(modelDir)
			return {
				resolve: (request) => {
					const deps: Dependency[] = []
					for (const field of walk(request.interpreted['graphql'])) {
						// getInjury → Injury, .account → Account, .company → Company.
						// Exact, not guessed — and it knows the file each one lives in.
						const entity = schema.resolve(field.path)
						if (!entity) continue
						deps.push({ kind: 'model', name: entity.name })
						deps.push({ kind: 'file', path: entity.file })
					}
					return deps
				},
			}
		},
	}
}
```

The second one is the point of the whole design: no table of strings expresses
it, and `mapOperation` can only express it by reimplementing everything else at
the same time.

## 6. Configuration

```ts
// browser-footprint.ts
import { contemberSchema, fileRoutes } from '@opice/harness/plugins'

export const footprint = {
	plugins: [contemberSchema(), fileRoutes({ dir: 'app/routes' })],
	redactSegment: (segment, { index, segments }) => segments[index - 1] === 'customers',
}
```

**Additive, not replacing.** The built-in set (`graphql()`, `contember()`, the
verb+Entity rule, URL id shapes) is always present; `plugins` adds to it. This is
the opposite of the usual "your array replaces the default" convention, and
deliberately so: with GraphQL parsing itself now a plugin, replace-semantics
would let `plugins: [mine()]` silently switch off GraphQL entirely. Removal is
explicit — `builtins: false`, or `without: ['contember']` for one of them.

The repo's existing top-level hooks (`normalizeUrl`, `redactSegment`,
`mapOperation`, `transparentFields`) are unchanged: `loadFootprintConfig` wraps
them into an implicit anonymous plugin at the head of the chain. A repo with one
`redactSegment` never has to learn what a plugin is.

## 7. Safety

### 7.1 A plugin cannot fail a run

Every hook call is wrapped individually. A throwing hook is skipped, the chain
continues, and the warning names the plugin. The subtle half: **a hook that threw
must degrade its dimension to `partial`, not to "collected and empty"**.
`derivePartialDimensions` already does this for `mapperFailures → models`; the
plugin system extends it uniformly, so a broken plugin can never produce a
confident empty set that replaces good edges in the index. A `bind` that throws
disables the plugin and marks its declared `dimensions` partial.

This slightly widens today's behaviour: a throwing `normalizeUrl` currently only
warns, and would now also mark `endpoints` partial. That is the correct reading —
a user writes `normalizeUrl` because the built-in templating is wrong for their
app, so falling back to it produces routes they have already said are wrong.

### 7.2 A plugin cannot leak

What the hooks receive: a method, a templated route, parameter names, a status,
field names, argument key paths, a path, a component name, and a read-only
assembled footprint. **No Playwright object, no `Request`, no body, no headers,
no cookies, no argument values, no variables.** Enforced by the signatures — there
is nothing in a plugin's hands that isn't already in the footprint.

This is why the page-level collectors stay built-in (§1.1) and why there are no
page lifecycle hooks. `onPageLoad(page)` would hand a plugin everything. A plugin
that needs to read something reads it from the repo, as ordinary node code —
opice is not the one handing it over.

### 7.3 A plugin may confess incompleteness, never claim completeness

A plugin can add dependencies, and a plugin failure can add to `partial` — but
nothing a plugin does can *remove* from `partial` or set `collected`. Claiming a
dimension complete is the one thing that lets bad data *replace* good data in the
index, so it stays with the collector, which is the only thing that knows what
actually ran.

## 8. Sequencing

Separable, most valuable first:

1. **The parser: selection tree + argument key names (§5.1–5.2).** ✅ Standalone,
   no plugin system needed.
2. **The plugin interface + moving the built-ins onto it (§4, §5.4).** ✅
   Behaviour-neutral: `contember()` ships in `defaultPlugins()`.
3. **`fileRoutes()`** ✅ — the first plugin that turns an endpoint into a file.
   Proof the interface is general without needing a schema reader.
4. **`contemberSchema()`** ✅ — closes §2.2 properly. Verified against a real
   repo rather than fixtures (§12), which is where its two most useful findings
   came from.

1 without 2 is useful on its own. 2 without 1 would ship an interface whose most
important observation has nothing to look at.

## 9. Costs

Worth naming, because this is bigger than the alternative:

- **~1100 lines including tests.** It does NOT touch the stored blob (§11), so
  the worker's only change is accepting `source: 'plugin'` on a file entry.
- **Every seam becomes public API.** Changing how the collector works internally
  becomes a breaking change for third-party plugins. Mitigation: keep the hook
  set small and anchored to seams that already exist, and don't expose one
  speculatively — which is why `interpret` and `finish` were dropped (§11).
- **`partial` gains a plugin dimension.** Which plugin was responsible for a
  dimension being partial is now a real question, and it is the safety-critical
  part — getting it wrong is the silent-index-narrowing failure the whole feature
  exists to prevent. §3's closed vocabulary is what keeps this bounded.
- **Per-request chain cost.** Negligible in absolute terms (a few thousand
  requests, plain function calls), but it is no longer one straight path.

## 10. Open questions

1. **Relation-derived models on the dashboard.** Mark them (`via: 'relation'` —
   a column and a migration) so precision and recall can differ, or leave them
   indistinguishable and accept approximate names in the UI? §5.3.
2. **Do file dependencies from a resolver count as `exercised`?** A schema plugin
   knows the scenario *queried* the entity, not that the browser executed
   `Company.ts`. Recording them exercised is the strongest claim the data
   supports (consistent with how a coverage-less run is treated) — but it is the
   flag that keeps the file dimension from saturating, so it deserves a decision
   rather than a default.
3. **`query` in `IGNORED_ROOT_FIELDS`** — spec or Contember? `__*` is plainly
   spec, `_info`/`ok`/`errorMessage` plainly Contember; `query` needs a check
   against a real schema.
4. **Where `ignoredRootFields` applies.** Today it filters during parsing, so an
   ignored field never reaches `rootFields` — which contradicts "the raw
   rootFields are always reported, so nothing is lost". Moving it to the resolve
   phase keeps the report faithful. Changes what the dashboard shows, so it is
   proposed separately.
5. **Where the plugins live.** In-harness (one package to version) vs
   `@opice/plugin-*` (a rule fix doesn't need a harness release). Recommend
   in-harness until a third-party plugin exists.

## 11. As built — where the implementation deviated

Recorded because a design doc that quietly disagrees with the code is worse than
no design doc.

**The selection tree is not stored.** The design said the blob grows; it doesn't.
The tree's only consumer is a `resolve` hook, which runs in the harness during
collection — the dashboard doesn't render it and the index doesn't key on it. So
it lives on `ParsedOperation` in memory and is dropped when the footprint is
serialized. This removed the whole "the worker must accept and sanitize the tree"
cost, and with it the blob-size risk of 500 nodes times 2000 requests.

**No `interpret` hook.** The design had interpreters (request → richer
observation) as a peer of resolvers. Nothing in the repo needed one — GraphQL
parsing stays built in (§5) — and the design's own rule is not to expose a seam
speculatively. Plugins receive the parsed operations on the observation instead.
If a second interpretation layer ever earns its place (a REST convention, a
protobuf body), this is where it goes.

**No `finish` hook.** Same reasoning: `fileRoutes` and the schema resolver both
work through `resolve`, and a patch API that can add to `partial` but not remove
from it is real complexity to carry for no caller. §7.3 still holds — it is now
enforced by there being no way for a plugin to say anything about completeness at
all.

**A `model` hook was added back.** The generalized design replaced it with
`resolve`, but the two answer different questions: `model` is field → entity
(per operation, so the models land on the right request in the dashboard),
`resolve` is request → dependencies (cross-cutting, and the only one that can
emit files). Contember's `validate` rule needs the first; `fileRoutes` needs the
second. Collapsing them would have put validate-derived models on the scenario
but not on the operation that caused them.

**`Dependency` has no `endpoint` kind.** An endpoint is what the collector
observes natively from the request; a plugin has nothing to add. Plugins still
shape that dimension through `route`/`segment`, which is why they may still
declare it in `dimensions`.

**Plugins are additive with a `without` list**, as §6 proposed — no
replace-semantics, because with conventions living in plugins a single added
plugin would otherwise silently switch off Contember's `transaction` unwrapping.

**One safety rule came out of the code, not the design.** `toRouteTemplate`
already redacted a segment whose predicate threw (`:id` is the side that cannot
leak). The plugin chain's general rule — a throwing hook is skipped and the chain
continues — would have quietly reversed that for `segment`, keeping a segment
nobody could vouch for. `segment` is therefore the one seam where a throw means
*redact*, and it has its own test.

## 12. Verified against a real Contember repo

Run read-only against a client repo (`~/projects/external/npi`) — 304 entities,
973 relations, 204 opice scenarios. Nothing in it was modified.

**The schema reader is exact on real input.** It resolved every one of the 973
relation targets to a class it had also found: zero dangling names. A scanner
that was mis-reading the definition style would show up here first, as targets
pointing at nothing.

**Real chains resolve across directories:**

```
SupplierInvoice (packages/api/model/supplier-invoice.ts)
  → Contract (packages/api/model/contract.ts)
  → Organization (packages/api/model/edu/organization.ts)
```

**Against the repo's real queries.** 330 GraphQL documents harvested from 106 of
its test files and pushed through parse → plugin:

| | |
|---|---|
| documents where the plugin found a dependency the built-in missed | **112 / 330** (34%) |
| models named | 311 → **463** (1.49×) |
| distinct schema files named as dependencies | 46 |

Most of the new edges come through **filter arguments**, not the selection set —
`listEducationProgramSession(filter: { program: { id: { eq: $id } } })` depends on
`EducationProgram` and says so nowhere else. That half of §2.2 would have been
easy to skip, and it turns out to be the bigger one.

### 12.1 A bug the real repo exposed, independent of plugins

The worker matches a changed path against a model edge by basename. Contember
defines `EducationProgramSession` in `education-program-session.ts` — the two
spell the same thing differently, and the comparison was exact-after-lowercasing.
**203 of 304 entities (67%) live in a multi-word file**, so for two thirds of the
schema, editing an entity selected nothing through the model dimension. Only the
single-word minority (`Contract`, `Organization`) ever matched.

Fixed in `matchImpact` by also indexing the basename with word separators
removed. Collisions can only ever *add* a selection, which is the safe direction
for a mechanism whose whole design rule is that it never subtracts.

This is worth separating from the plugin work: it is a fix every repo gets, with
no plugin installed and no footprint re-collected. The plugin's file edges make
the same match *exactly* rather than by heuristic, but the heuristic had to work
regardless — and this is the kind of thing only real data shows. A fixture repo
would have been called `Contract.ts`.
