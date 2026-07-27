/**
 * The degradation ledger — every way collection can come up short, declared once.
 *
 * A footprint reports degradation twice over: as `warnings` a human reads on the
 * dashboard, and as `partial` dimensions the change-tracking index acts on. That
 * duplication is deliberate — prose no machine can read, a dimension list no
 * human would learn anything from — but the *knowledge* behind it is one thing,
 * so each signal is written down here exactly once: what it is called, which
 * dimensions it can no longer vouch for, and how it phrases itself. The collector
 * notes signals as it observes them and asks for {@link DegradationLedger.warnings}
 * and {@link DegradationLedger.dimensions} at the end, rather than restating the
 * same facts in two shapes at either end of the file.
 */

import type { FootprintDimension } from './types.js'

/**
 * Caps on what one scenario may record. A runaway polling loop or an app that
 * lazy-loads a thousand modules must not turn a footprint into a multi-megabyte
 * blob. Hitting a cap is always reported as a warning — a silently truncated
 * footprint would read as "the scenario touches this much", which would be a lie.
 *
 * They live beside the warning that reports them so the number in the prose can
 * never drift from the number that enforces it.
 */
export const MAX_REQUESTS = 2000
export const MAX_FILES = 5000

/** Something the collector saw happen to itself. Counted; a flag is one noted once. */
export type ObservedSignal =
	| 'truncatedRequests'
	| 'truncatedFiles'
	| 'oversizedBodies'
	| 'unreadableOperations'
	| 'componentsTruncated'
	| 'persistedQueries'
	| 'truncatedSelections'
	| 'mapperFailures'
	| 'coverageFailed'
	| 'unmappableScripts'
	| 'unmappableStyles'
	| 'unmappedBundles'
	| 'coverageRan'
	| 'uninstrumentedPages'

/** Computed from the observations rather than seen — see the declarations below. */
export type DerivedSignal = 'unmappableFiles'

export type DegradationSignal = ObservedSignal | DerivedSignal

interface BaseDeclaration {
	/**
	 * Dimensions this signal can no longer vouch for. Empty when the signal is
	 * merely an input to a derived one — an observation, not yet a degradation.
	 */
	dimensions: readonly FootprintDimension[]
	/**
	 * How the signal phrases itself for a human. Omitted where the observation site
	 * writes its own line because it carries an error message: there is nothing to
	 * aggregate, and the message is the interesting half.
	 */
	warning?: (count: number) => string
}

interface ObservedDeclaration extends BaseDeclaration {
	signal: ObservedSignal
	derive?: undefined
}

interface DerivedDeclaration extends BaseDeclaration {
	signal: DerivedSignal
	/** A computed signal: its count is a function of the raw observations. */
	derive: (count: (signal: ObservedSignal) => number) => number
}

type Declaration = ObservedDeclaration | DerivedDeclaration

/**
 * Every signal, in the order its warning is reported.
 *
 * Adding a way for collection to degrade means adding an entry here and noting it
 * at the observation site — nothing else, and in particular nothing that can go
 * out of step with the warning a user reads.
 */
const DECLARATIONS: readonly Declaration[] = [
	{
		/** Requests dropped past the per-scenario cap. */
		signal: 'truncatedRequests',
		// Requests feed both dimensions, so a truncated stream makes both a sample.
		dimensions: ['endpoints', 'models'],
		warning: (count) => `${count} request(s) dropped — the per-scenario cap of ${MAX_REQUESTS} was reached.`,
	},
	{
		/** Files dropped past the per-scenario cap. */
		signal: 'truncatedFiles',
		dimensions: ['files'],
		warning: (count) => `${count} file(s) dropped — the per-scenario cap of ${MAX_FILES} was reached.`,
	},
	{
		/** GraphQL request bodies too large to scan, so their operations are unknown. */
		signal: 'oversizedBodies',
		dimensions: ['models'],
		warning: (count) =>
			`${count} GraphQL request(s) had a body too large to scan — their fields and models are not in this footprint.`,
	},
	{
		/** GraphQL requests recognised but whose document never reached us (a GET with `?query=`). */
		signal: 'unreadableOperations',
		dimensions: ['models'],
		warning: (count) =>
			`${count} GraphQL request(s) carried no readable document — their fields and models are not in this footprint.`,
	},
	{
		/** The in-page fiber walk hit its node cap, so the component list is a sample. */
		signal: 'componentsTruncated',
		dimensions: ['components'],
		warning: () => 'the React tree exceeded the per-walk node cap — components past it are not in this footprint.',
	},
	{
		/**
		 * A persisted query is a perfectly visible endpoint whose document — and so
		 * whose models — never crossed the wire. Only the model side suffers, and the
		 * same is true of a mapper that threw.
		 */
		signal: 'persistedQueries',
		dimensions: ['models'],
		warning: (count) =>
			`${count} persisted GraphQL request(s) carried only a hash — their fields and models are not in this footprint.`,
	},
	{
		/**
		 * Operations whose selection tree hit a cap: a resolver that walks relations
		 * saw a sample of them, so the models it derived are a sample of the set.
		 */
		signal: 'truncatedSelections',
		dimensions: ['models'],
		warning: (count) =>
			`${count} GraphQL operation(s) had a selection too large to walk in full — a resolver saw a sample of their fields.`,
	},
	{
		/** Operations whose user-supplied `mapOperation` threw; their models fell back to the built-in derivation. */
		signal: 'mapperFailures',
		dimensions: ['models'],
	},
	{
		/** The coverage pass was started and then failed, so the file dimension can't claim completeness. */
		signal: 'coverageFailed',
		dimensions: ['files'],
	},
	{
		/** Script requests whose source path could not be recovered — a bundle, not a dev server. Coverage may still resolve these. */
		signal: 'unmappableScripts',
		dimensions: [],
	},
	{
		/** Stylesheet requests whose source could not be recovered. NOTHING else can resolve these — V8 coverage is JS-only. */
		signal: 'unmappableStyles',
		dimensions: [],
	},
	{
		/** Bundles coverage could not resolve to sources, from its own source-map pass. */
		signal: 'unmappedBundles',
		dimensions: [],
	},
	{
		/** Noted once the coverage pass has returned — its verdict on bundles supersedes the module collector's. */
		signal: 'coverageRan',
		dimensions: [],
	},
	{
		/** Noted when the scenario opened a page coverage never instrumented (a popup, a new tab). */
		signal: 'uninstrumentedPages',
		dimensions: [],
	},
	{
		/**
		 * Files nothing could name. When coverage ran, this is ITS count of
		 * unresolvable bundles — the module collector cannot name a bundled script by
		 * definition, so its own tally would condemn every production app, including
		 * the ones whose source maps resolve perfectly.
		 */
		signal: 'unmappableFiles',
		dimensions: ['files'],
		// What the MODULE collector could not name only counts against us when
		// nothing else could name it either. For SCRIPTS, coverage is that second
		// chance, so when it ran its own tally supersedes this one — unless the
		// scenario opened a page coverage never instrumented, whose bundles it cannot
		// have resolved and cannot speak for. Stylesheets have no second chance at
		// all — coverage is JS-only — so their count always stands.
		derive: (count) =>
			(count('coverageRan') > 0 && count('uninstrumentedPages') === 0 ? count('unmappedBundles') : count('unmappableScripts'))
			+ count('unmappableStyles'),
	},
]

/**
 * What one scenario's collection could not vouch for, accumulated as it runs.
 *
 * Never throws and never needs a browser: it is counters and pure functions over
 * them, which is what lets the rules be tested without one.
 */
export class DegradationLedger {
	private readonly counts = new Map<ObservedSignal, number>()
	private readonly notes = new Set<string>()

	/** Note a signal. A flag is a counter noted once; `times` of zero is not an observation. */
	note(signal: ObservedSignal, times = 1): void {
		if (times <= 0) return
		this.counts.set(signal, this.count(signal) + times)
	}

	/**
	 * A warning that carries its own message — an error string, or a note fired by
	 * a raw observation rather than by the signal derived from it. It has no count
	 * to aggregate over; the signal noted beside it is what degrades a dimension.
	 */
	warn(warning: string): void {
		this.notes.add(warning)
	}

	/** Everything that degraded this footprint, in prose. Deduplicated; a counted signal reports one line with its total. */
	warnings(): string[] {
		const out = new Set(this.notes)
		for (const declaration of DECLARATIONS) {
			if (!declaration.warning) continue
			const count = this.effective(declaration)
			if (count > 0) out.add(declaration.warning(count))
		}
		return [...out]
	}

	/**
	 * Which dimensions this run collected but cannot vouch for.
	 *
	 * The index replaces a scenario's edges wholesale, so a dimension listed here is
	 * left exactly as a previous run left it. Every signal declared above has a
	 * matching human-readable warning — its own, or one its observation site writes;
	 * this is the half a machine can act on, and it is a pure function of the
	 * counters so it can be reasoned about without a browser.
	 */
	dimensions(): FootprintDimension[] {
		const partial = new Set<FootprintDimension>()
		for (const declaration of DECLARATIONS) {
			if (this.effective(declaration) === 0) continue
			for (const dimension of declaration.dimensions) partial.add(dimension)
		}
		return [...partial]
	}

	private effective(declaration: Declaration): number {
		return declaration.derive ? declaration.derive(this.count) : this.count(declaration.signal)
	}

	private readonly count = (signal: ObservedSignal): number => this.counts.get(signal) ?? 0
}
