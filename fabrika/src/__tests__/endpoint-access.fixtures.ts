export const fixtures = {
	'api.projects.create': { slug: 'generated-project', name: 'Generated project' },
}

export const rows = {
	'api.runs.steps': { scenarioId: 'scenarios' },
	'api.runs.screenshot': { stepId: 'steps' },
	'machine.reports.finishScenario': { scenarioId: 'scenarios' },
	'machine.reports.step': { scenarioId: 'scenarios' },
	'machine.reads.steps': { scenarioId: 'scenarios' },
	'machine.reads.screenshot': { stepId: 'steps' },
	'shared.steps': { scenarioId: 'scenarios' },
	'shared.screenshot': { stepId: 'steps' },
}

export const links = { 'api.shares.revoke': ['linkId'] }
