// Who may do what in Opice. A project is the top-level scope IAM grants in; a run lies in its project. Operators hold
// `viewer` or `editor` application-wide; a project's creator holds `owner` there. A CI key holds `report.write` (and
// `report.read`) in one project.

import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'opice',
	displayName: 'Opice',
	dimensions: {
		project: { creator: 'owner' },
		run: { in: 'project' },
	},
	actions: {
		'project.read': 'See projects and their run lists',
		'project.write': 'Create projects and share runs',
		'report.read': 'Read runs, scenarios, steps and screenshots',
		'report.write': 'Report test runs',
	},
	roles: {
		viewer: { grants: ['project.read', 'report.read'] },
		editor: { grants: ['project.read', 'project.write', 'report.read', 'report.write'] },
		owner: {
			grants: ['project.read', 'project.write', 'report.read', 'report.write'],
			member: { scope: 'project', assignableBy: ['owner'] },
		},
	},
})
