import { describe, expect, test } from 'bun:test'
import { DegradationLedger } from './degradation'

describe('DegradationLedger', () => {
	test('a clean run vouches for everything', () => {
		const ledger = new DegradationLedger()
		expect(ledger.dimensions()).toEqual([])
		expect(ledger.warnings()).toEqual([])
	})

	// Against a bundle the module collector runs to completion and recognises
	// nothing. "No files" there means "could not tell".
	test('unmappable bundle assets make files partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('unmappableScripts', 12)
		expect(ledger.dimensions()).toEqual(['files'])
	})

	test('a failed coverage pass makes files partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('coverageFailed')
		expect(ledger.dimensions()).toEqual(['files'])
	})

	test('hitting the file cap makes files partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedFiles', 3)
		expect(ledger.dimensions()).toEqual(['files'])
	})

	// The request stream feeds both, so losing it costs both.
	test('hitting the request cap makes endpoints and models partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedRequests', 5)
		expect(ledger.dimensions().sort()).toEqual(['endpoints', 'models'])
	})

	// The endpoint was perfectly visible; only the document was missing.
	test('persisted queries cost the models alone', () => {
		const ledger = new DegradationLedger()
		ledger.note('persistedQueries', 2)
		expect(ledger.dimensions()).toEqual(['models'])
	})

	test('a throwing mapOperation costs the models alone', () => {
		const ledger = new DegradationLedger()
		ledger.note('mapperFailures')
		expect(ledger.dimensions()).toEqual(['models'])
	})

	// A resolver that walks relations saw a sample of them, so the models it
	// derived are a sample of the set.
	test('a truncated selection tree costs the models alone', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedSelections')
		expect(ledger.dimensions()).toEqual(['models'])
	})

	test('reports each dimension once however many signals fired', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedFiles')
		ledger.note('unmappableScripts')
		ledger.note('coverageFailed')
		ledger.note('truncatedRequests')
		ledger.note('persistedQueries')
		ledger.note('mapperFailures')
		expect(ledger.dimensions().sort()).toEqual(['endpoints', 'files', 'models'])
	})

	// The two dimensions a signal degrades are a property of its declaration, not
	// of the call site — one note of it has to reach both, and neither more.
	test('a signal declared with two dimensions degrades both', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedRequests')
		expect(ledger.dimensions().sort()).toEqual(['endpoints', 'models'])
	})

	// A signal not noted is a signal that did not happen, whatever the argument.
	test('noting zero times is not an observation', () => {
		const ledger = new DegradationLedger()
		ledger.note('persistedQueries', 0)
		expect(ledger.dimensions()).toEqual([])
		expect(ledger.warnings()).toEqual([])
	})
})

// The wording is user-visible — it lands on a dashboard beside the footprint —
// and it is now a property of the declaration rather than of the collector, so
// it is pinned here.
describe('DegradationLedger — warnings', () => {
	test('a cap warning names both the count and the cap', () => {
		const ledger = new DegradationLedger()
		ledger.note('truncatedRequests', 3)
		expect(ledger.warnings()).toEqual(['3 request(s) dropped — the per-scenario cap of 2000 was reached.'])
	})

	test('a counted signal sums its observations into one line', () => {
		const ledger = new DegradationLedger()
		ledger.note('persistedQueries', 2)
		ledger.note('persistedQueries', 1)
		expect(ledger.warnings()).toEqual([
			'3 persisted GraphQL request(s) carried only a hash — their fields and models are not in this footprint.',
		])
	})

	// A signal whose site writes its own line (it carries an error message) still
	// degrades its dimension — the two halves are independent.
	test('a signal with no declared phrasing still degrades its dimension', () => {
		const ledger = new DegradationLedger()
		ledger.note('mapperFailures')
		ledger.warn('mapOperation threw (falling back to the built-in model derivation): boom')
		expect(ledger.warnings()).toEqual(['mapOperation threw (falling back to the built-in model derivation): boom'])
		expect(ledger.dimensions()).toEqual(['models'])
	})

	// One line however many times the same thing was observed.
	test('repeated free-form warnings are deduplicated', () => {
		const ledger = new DegradationLedger()
		ledger.warn('the app under test is serving bundled assets — file-level footprint needs a dev server or source maps.')
		ledger.warn('the app under test is serving bundled assets — file-level footprint needs a dev server or source maps.')
		expect(ledger.warnings()).toHaveLength(1)
	})
})

// Regression: a production bundle WITH working source maps must still index.
// The module collector cannot name a bundled script by definition, so taking its
// word for it marked every such app's files partial and file-based impact
// selection could never populate.
describe('DegradationLedger — bundles with usable source maps', () => {
	test('a bundle coverage resolved is not partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('unmappableScripts', 12)
		// Coverage ran and reported zero unresolvable bundles.
		ledger.note('coverageRan')
		ledger.note('unmappedBundles', 0)
		expect(ledger.dimensions()).toEqual([])
	})

	test('a bundle coverage could NOT resolve is partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('unmappableScripts', 12)
		ledger.note('coverageRan')
		ledger.note('unmappedBundles', 7)
		expect(ledger.dimensions()).toEqual(['files'])
	})

	// Coverage instruments the page it was started on. A popup's bundles it never
	// saw are bundles it cannot speak for, so its tally stops superseding the
	// module collector's.
	test('a page coverage never instrumented keeps the module tally', () => {
		const ledger = new DegradationLedger()
		ledger.note('unmappableScripts', 12)
		ledger.note('coverageRan')
		ledger.note('unmappedBundles', 0)
		ledger.note('uninstrumentedPages')
		expect(ledger.dimensions()).toEqual(['files'])
	})
})

describe('DegradationLedger — component walk cap', () => {
	// A React tree past the node cap stops being walked, so the names collected
	// are a sample — and component edges are replaced wholesale.
	test('a capped fiber walk makes components partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('componentsTruncated')
		expect(ledger.dimensions()).toEqual(['components'])
	})

	test('an uncapped walk vouches for components', () => {
		const ledger = new DegradationLedger()
		expect(ledger.dimensions()).toEqual([])
	})
})

describe('DegradationLedger — unreadable coverage and oversized bodies', () => {
	// A pass that could not be READ resolved nothing, which is not the same as
	// "every bundle resolved" — taking its empty file list as authoritative would
	// let it wipe the index.
	test('an unreadable coverage pass makes files partial', () => {
		const ledger = new DegradationLedger()
		ledger.note('coverageFailed')
		ledger.note('unmappedBundles', 0)
		expect(ledger.dimensions()).toEqual(['files'])
	})

	// The endpoint was visible; only the document was too large to scan.
	test('an oversized GraphQL body costs the models alone', () => {
		const ledger = new DegradationLedger()
		ledger.note('oversizedBodies')
		expect(ledger.dimensions()).toEqual(['models'])
	})
})

describe('DegradationLedger — unreadable GraphQL documents', () => {
	// A GraphQL GET carrying `?query=…` is recognised as GraphQL, but Playwright
	// reports no post data, so no document ever reaches the parser. Without this
	// the models would read as an authoritative "none".
	test('a request with no readable document costs the models', () => {
		const ledger = new DegradationLedger()
		ledger.note('unreadableOperations')
		expect(ledger.dimensions()).toEqual(['models'])
	})
})

// Coverage is JS-only. A production build with mappable JS and a bundled
// stylesheet must not report the file dimension complete: every CSS source is
// missing from it, so a later CSS change would select nothing.
describe('DegradationLedger — bundled CSS has no second chance', () => {
	test('mappable JS plus unresolved CSS is still partial', () => {
		const ledger = new DegradationLedger()
		// Coverage resolved every script (0), but one stylesheet stayed unnamed.
		ledger.note('coverageRan')
		ledger.note('unmappedBundles', 0)
		ledger.note('unmappableStyles', 1)
		expect(ledger.dimensions()).toEqual(['files'])
	})

	test('everything resolved is complete', () => {
		const ledger = new DegradationLedger()
		ledger.note('coverageRan')
		ledger.note('unmappedBundles', 0)
		expect(ledger.dimensions()).toEqual([])
	})
})
