import type { Project, Run, Scenario, Step } from './types'

export class Db {
	constructor(private readonly d1: D1Database) {}

	async getProjectBySlug(slug: string): Promise<Project | null> {
		return this.d1
			.prepare('SELECT * FROM projects WHERE slug = ?')
			.bind(slug)
			.first<Project>()
	}

	async listProjects(): Promise<Project[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM projects ORDER BY created_at DESC')
			.all<Project>()
		return results
	}

	async createRun(input: { id: string; projectId: number; branch?: string; commit?: string; startedAt: number }): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO runs (id, project_id, branch, commit_sha, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
			.bind(input.id, input.projectId, input.branch ?? null, input.commit ?? null, input.startedAt)
			.run()
	}

	async getRun(id: string): Promise<Run | null> {
		return this.d1.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<Run>()
	}

	async listRunsForProject(projectId: number, limit = 50): Promise<Run[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
			.bind(projectId, limit)
			.all<Run>()
		return results
	}

	async finishRun(id: string, finishedAt: number): Promise<void> {
		// Compute scenario counts + final status from scenarios table.
		const counts = await this.d1
			.prepare(`SELECT
				COUNT(*) AS total,
				SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			FROM scenarios WHERE run_id = ?`)
			.bind(id)
			.first<{ total: number; passed: number; failed: number }>()
		const total = counts?.total ?? 0
		const passed = counts?.passed ?? 0
		const failed = counts?.failed ?? 0
		const status = failed > 0 || total === 0 ? 'failed' : 'passed'
		await this.d1
			.prepare(`UPDATE runs SET status = ?, total_scenarios = ?, passed_scenarios = ?, failed_scenarios = ?, finished_at = ? WHERE id = ?`)
			.bind(status, total, passed, failed, finishedAt, id)
			.run()
	}

	async createScenario(input: { id: string; runId: string; name: string; hash?: string; startedAt: number }): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO scenarios (id, run_id, name, hash, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
			.bind(input.id, input.runId, input.name, input.hash ?? null, input.startedAt)
			.run()
	}

	async finishScenario(input: { id: string; status: 'passed' | 'failed'; durationMs: number; finishedAt: number }): Promise<void> {
		await this.d1
			.prepare(`UPDATE scenarios SET status = ?, duration_ms = ?, finished_at = ? WHERE id = ?`)
			.bind(input.status, input.durationMs, input.finishedAt, input.id)
			.run()
	}

	async listScenariosForRun(runId: string): Promise<Scenario[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM scenarios WHERE run_id = ? ORDER BY started_at')
			.bind(runId)
			.all<Scenario>()
		return results
	}

	async createStep(input: {
		scenarioId: string
		name: string
		status: 'passed' | 'failed'
		durationMs: number
		error?: string
		screenshotR2Key?: string
	}): Promise<number> {
		const seqRow = await this.d1
			.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM steps WHERE scenario_id = ?')
			.bind(input.scenarioId)
			.first<{ next: number }>()
		const sequence = seqRow?.next ?? 0
		const result = await this.d1
			.prepare(`INSERT INTO steps (scenario_id, sequence, name, status, duration_ms, error, screenshot_r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.scenarioId,
				sequence,
				input.name,
				input.status,
				input.durationMs,
				input.error ?? null,
				input.screenshotR2Key ?? null,
				Date.now(),
			)
			.run()
		return Number(result.meta.last_row_id)
	}

	async listStepsForScenario(scenarioId: string): Promise<Step[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM steps WHERE scenario_id = ? ORDER BY sequence')
			.bind(scenarioId)
			.all<Step>()
		return results
	}
}
