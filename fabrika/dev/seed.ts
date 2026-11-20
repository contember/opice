// `fabrika app dev`'s data: two projects whose CI reported the runs of `runs.ts` through the machine mount, an
// operator, a viewer, and a share link to the failed run.
import { createClient } from '@fabrika/app/client'
import type { DevSeed } from '@fabrika/app/testing'
import { contract } from '../fabrika.contract'
import { type SeedRun, seedProjects } from './runs'
import { screenshotPng } from './screenshot'

const OK: readonly [number, number, number] = [37, 99, 235]
const FAILED: readonly [number, number, number] = [220, 38, 38]

const seed: DevSeed<typeof contract> = async (dev) => {
	const ada = dev.testCaller([{ role: 'editor' }], { label: 'Ada Lovelace', email: 'ada@example.test' })
	const ben = dev.testCaller([{ role: 'viewer' }], { label: 'Ben Okafor', email: 'ben@example.test' })
	const api = createClient(contract, 'api', { fetch: dev.browser(ada) })

	const scopes: { value: string; label: string }[] = []
	const links: { title: string; description: string; url: string }[] = []
	for (const project of seedProjects) {
		const created = await api.projects.create({ slug: project.slug, name: project.name })
		scopes.push({ value: created.id, label: project.name })
		const key = dev.testCaller([{ action: 'report.write', scope: { type: 'project', value: created.id } }], { kind: 'machine' })
		const ci = createClient(contract, 'machine', { fetch: dev.fetch, key: key.key ?? undefined })
		for (const run of project.runs) {
			const runId = await report(ci, created.id, run)
			if (run.scenarios.some((scenario) => scenario.status === 'failed')) {
				const { url } = await api.shares.create({ runId })
				links.push({ title: `Shared failed run of ${project.name}`, description: 'The read-only share view', url })
			}
		}
	}

	return {
		personas: [
			{ name: 'Ada', description: 'An operator: creates projects and shares runs', caller: ada },
			{ name: 'Ben', description: 'A viewer: reads every project', caller: ben },
		],
		links,
		scopes: { project: scopes },
	}
}

type Machine = ReturnType<typeof createClient<typeof contract, 'machine'>>

async function report(ci: Machine, projectId: string, run: SeedRun): Promise<string> {
	const { runId } = await ci.reports.startRun({ projectId, branch: run.branch, commit: run.commit, source: 'ci', tier: run.tier })
	for (const scenario of run.scenarios) {
		const started = await ci.reports.startScenario({
			runId,
			name: scenario.name,
			feature: scenario.feature,
			testFile: scenario.testFile,
			skipped: scenario.skipped === undefined ? undefined : true,
			reason: scenario.skipped,
		})
		if (scenario.skipped !== undefined) continue
		for (const [sequence, step] of scenario.steps.entries()) {
			await ci.reports.step({
				runId,
				scenarioId: started.scenarioId,
				sequence,
				kind: step.kind,
				name: step.name,
				status: step.status,
				durationMs: step.durationMs,
				intent: step.intent,
				error: step.error,
				reason: step.reason,
				screenshot: step.screenshot === undefined ? undefined : screenshotPng(step.screenshot === 'failed' ? FAILED : OK),
			})
		}
		await ci.reports.finishScenario({
			runId,
			scenarioId: started.scenarioId,
			status: scenario.status,
			durationMs: scenario.durationMs,
			attempts: scenario.attempts,
		})
	}
	await ci.reports.finishRun({ runId })
	return runId
}

export default seed
