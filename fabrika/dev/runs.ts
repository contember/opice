// The runs the dev seed reports: one of each kind the dashboard tells apart (passed, failed, flaky, a known failure,
// skipped and pending scenarios).

export interface SeedStep {
	readonly name: string
	readonly status: 'passed' | 'failed' | 'fixme' | 'fixmepass' | 'pending'
	readonly durationMs: number
	readonly kind?: 'step' | 'invariant'
	readonly intent?: string
	readonly error?: string
	readonly reason?: string
	readonly screenshot?: 'ok' | 'failed'
}

export interface SeedScenario {
	readonly name: string
	readonly feature?: string
	readonly testFile: string
	readonly status: 'passed' | 'failed'
	readonly attempts?: number
	readonly durationMs: number
	readonly skipped?: string
	readonly steps: readonly SeedStep[]
}

export interface SeedRun {
	readonly branch: string
	readonly commit: string
	readonly tier?: string
	readonly scenarios: readonly SeedScenario[]
}

export interface SeedProject {
	readonly slug: string
	readonly name: string
	readonly runs: readonly SeedRun[]
}

const signIn: SeedScenario = {
	name: 'A customer signs in',
	feature: 'AUTH-1',
	testFile: 'tests/browser/sign-in.test.ts',
	status: 'passed',
	durationMs: 4210,
	steps: [
		{ name: 'open the sign-in page', status: 'passed', durationMs: 820, intent: 'The page loads for a visitor.', screenshot: 'ok' },
		{ name: 'submit valid credentials', status: 'passed', durationMs: 1430, screenshot: 'ok' },
		{ name: 'lands on the dashboard', status: 'passed', durationMs: 610, kind: 'invariant', screenshot: 'ok' },
	],
}

const checkout: SeedScenario = {
	name: 'A customer pays for the cart',
	feature: 'SHOP-4',
	testFile: 'tests/browser/checkout.test.ts',
	status: 'passed',
	durationMs: 7340,
	steps: [
		{ name: 'add a product to the cart', status: 'passed', durationMs: 1200, screenshot: 'ok' },
		{ name: 'pay with a test card', status: 'passed', durationMs: 3100, screenshot: 'ok' },
	],
}

const checkoutFailed: SeedScenario = {
	...checkout,
	status: 'failed',
	durationMs: 9050,
	steps: [
		{ name: 'add a product to the cart', status: 'passed', durationMs: 1200, screenshot: 'ok' },
		{
			name: 'pay with a test card',
			status: 'failed',
			durationMs: 5020,
			intent: 'A valid card completes the order.',
			error: "expect(locator).toBeVisible() failed\n\nLocator: getByTestId('order-confirmation')\nExpected: visible\nTimeout: 5000ms",
			screenshot: 'failed',
		},
	],
}

const search: SeedScenario = {
	name: 'A visitor searches the catalogue',
	feature: 'SHOP-2',
	testFile: 'tests/browser/search.test.ts',
	status: 'passed',
	attempts: 2,
	durationMs: 5630,
	steps: [
		{ name: 'type a query', status: 'passed', durationMs: 900, screenshot: 'ok' },
		{ name: 'results show prices', status: 'fixme', durationMs: 1300, reason: 'prices load late on the first page', error: 'Timeout 3000ms exceeded', screenshot: 'ok' },
	],
}

const returns: SeedScenario = {
	name: 'A customer returns an order',
	feature: 'SHOP-9',
	testFile: 'tests/browser/returns.test.ts',
	status: 'passed',
	durationMs: 0,
	steps: [
		{ name: 'open the order history', status: 'pending', durationMs: 0, intent: 'The customer finds the order to return.' },
		{ name: 'print the return label', status: 'pending', durationMs: 0, reason: 'return labels are not built yet' },
	],
}

const export_: SeedScenario = {
	name: 'An administrator exports the orders',
	testFile: 'tests/browser/export.test.ts',
	status: 'passed',
	durationMs: 0,
	skipped: "tier 'extended' above the selected tier 'standard'",
	steps: [],
}

export const seedProjects: readonly SeedProject[] = [
	{
		slug: 'web-shop',
		name: 'Web shop',
		runs: [
			{ branch: 'main', commit: '4f2a91c', scenarios: [signIn, checkout] },
			{ branch: 'feat/checkout', commit: '9b13e07', scenarios: [signIn, checkoutFailed, search] },
			{ branch: 'main', commit: 'c7d0e55', tier: 'standard', scenarios: [signIn, checkout, search, returns, export_] },
		],
	},
	{
		slug: 'back-office',
		name: 'Back office',
		runs: [{ branch: 'main', commit: '1e8c3b2', scenarios: [signIn] }],
	},
]
