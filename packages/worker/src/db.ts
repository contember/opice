import type { Project, Run, RunStatus, Scenario, Step, StepStatus } from './types'

// Internal D1 row shapes — snake_case as the migration defines.
interface ProjectRow {
	id: number
	slug: string
	name: string
	api_key_hash: string
	read_token: string | null
	created_at: number
}

interface RunRow {
	id: string
	project_id: number
	branch: string | null
	commit_sha: string | null
	status: RunStatus
	total_scenarios: number
	passed_scenarios: number
	failed_scenarios: number
	started_at: number
	finished_at: number | null
}

interface ScenarioRow {
	id: string
	run_id: string
	name: string
	hash: string | null
	test_file: string | null
	scenario_file: string | null
	status: RunStatus
	duration_ms: number | null
	started_at: number
	finished_at: number | null
}

interface StepRow {
	id: number
	scenario_id: string
	sequence: number
	name: string
	status: StepStatus
	duration_ms: number
	error: string | null
	screenshot_r2_key: string | null
	created_at: number
}

const toProject = (r: ProjectRow): Project => ({
	id: r.id,
	slug: r.slug,
	name: r.name,
	apiKeyHash: r.api_key_hash,
	readToken: r.read_token,
	createdAt: r.created_at,
})

const toRun = (r: RunRow): Run => ({
	id: r.id,
	projectId: r.project_id,
	branch: r.branch,
	commitSha: r.commit_sha,
	status: r.status,
	totalScenarios: r.total_scenarios,
	passedScenarios: r.passed_scenarios,
	failedScenarios: r.failed_scenarios,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
})

const toScenario = (r: ScenarioRow): Scenario => ({
	id: r.id,
	runId: r.run_id,
	name: r.name,
	hash: r.hash,
	testFile: r.test_file,
	scenarioFile: r.scenario_file,
	status: r.status,
	durationMs: r.duration_ms,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
})

const toStep = (r: StepRow): Step => ({
	id: r.id,
	scenarioId: r.scenario_id,
	sequence: r.sequence,
	name: r.name,
	status: r.status,
	durationMs: r.duration_ms,
	error: r.error,
	screenshotKey: r.screenshot_r2_key,
	createdAt: r.created_at,
})

export class Db {
	constructor(private readonly d1: D1Database) {}

	async createProject(input: { slug: string; name: string; apiKeyHash: string; readToken: string }): Promise<Project> {
		const createdAt = Date.now()
		const result = await this.d1
			.prepare('INSERT INTO projects (slug, name, api_key_hash, read_token, created_at) VALUES (?, ?, ?, ?, ?)')
			.bind(input.slug, input.name, input.apiKeyHash, input.readToken, createdAt)
			.run()
		return {
			id: Number(result.meta.last_row_id),
			slug: input.slug,
			name: input.name,
			apiKeyHash: input.apiKeyHash,
			readToken: input.readToken,
			createdAt,
		}
	}

	async getProjectBySlug(slug: string): Promise<Project | null> {
		const row = await this.d1.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>()
		return row ? toProject(row) : null
	}

	async getProjectByApiKeyHash(hash: string): Promise<Project | null> {
		const row = await this.d1.prepare('SELECT * FROM projects WHERE api_key_hash = ?').bind(hash).first<ProjectRow>()
		return row ? toProject(row) : null
	}

	async getProjectByReadToken(token: string): Promise<Project | null> {
		const row = await this.d1.prepare('SELECT * FROM projects WHERE read_token = ?').bind(token).first<ProjectRow>()
		return row ? toProject(row) : null
	}

	async setReadToken(slug: string, token: string): Promise<void> {
		await this.d1.prepare('UPDATE projects SET read_token = ? WHERE slug = ?').bind(token, slug).run()
	}

	async listProjects(): Promise<Project[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM projects ORDER BY created_at DESC')
			.all<ProjectRow>()
		return results.map(toProject)
	}

	async createRun(input: { id: string; projectId: number; branch?: string; commit?: string }): Promise<Run> {
		const startedAt = Date.now()
		await this.d1
			.prepare(`INSERT INTO runs (id, project_id, branch, commit_sha, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`)
			.bind(input.id, input.projectId, input.branch ?? null, input.commit ?? null, startedAt)
			.run()
		return {
			id: input.id,
			projectId: input.projectId,
			branch: input.branch ?? null,
			commitSha: input.commit ?? null,
			status: 'running',
			totalScenarios: 0,
			passedScenarios: 0,
			failedScenarios: 0,
			startedAt,
			finishedAt: null,
		}
	}

	async getRun(id: string): Promise<Run | null> {
		const row = await this.d1.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
		return row ? toRun(row) : null
	}

	async listRunsForProject(projectId: number, limit = 50): Promise<Run[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?')
			.bind(projectId, limit)
			.all<RunRow>()
		return results.map(toRun)
	}

	async finishRun(id: string): Promise<void> {
		// Derive final status + counts from the run's scenarios.
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
		const status: RunStatus = failed > 0 || total === 0 ? 'failed' : 'passed'
		await this.d1
			.prepare(`UPDATE runs SET status = ?, total_scenarios = ?, passed_scenarios = ?, failed_scenarios = ?, finished_at = ? WHERE id = ?`)
			.bind(status, total, passed, failed, Date.now(), id)
			.run()
	}

	async createScenario(input: {
		id: string
		runId: string
		name: string
		hash?: string
		testFile?: string
		scenarioFile?: string
	}): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO scenarios (id, run_id, name, hash, test_file, scenario_file, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
			.bind(input.id, input.runId, input.name, input.hash ?? null, input.testFile ?? null, input.scenarioFile ?? null, Date.now())
			.run()
	}

	async getScenario(id: string): Promise<Scenario | null> {
		const row = await this.d1.prepare('SELECT * FROM scenarios WHERE id = ?').bind(id).first<ScenarioRow>()
		return row ? toScenario(row) : null
	}

	async finishScenario(input: { id: string; status: StepStatus; durationMs: number }): Promise<void> {
		await this.d1
			.prepare(`UPDATE scenarios SET status = ?, duration_ms = ?, finished_at = ? WHERE id = ?`)
			.bind(input.status, input.durationMs, Date.now(), input.id)
			.run()
	}

	async listScenariosForRun(runId: string): Promise<Scenario[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM scenarios WHERE run_id = ? ORDER BY started_at')
			.bind(runId)
			.all<ScenarioRow>()
		return results.map(toScenario)
	}

	async createStep(input: {
		scenarioId: string
		/**
		 * Authoring order from the harness. Authoritative when provided —
		 * step POSTs arrive fire-and-forget, so deriving order from arrival
		 * (MAX+1) reshuffles them by screenshot-encoding latency. Older
		 * clients omit it; fall back to MAX+1 for those.
		 */
		sequence?: number
		name: string
		status: StepStatus
		durationMs: number
		error?: string
		screenshotKey?: string
	}): Promise<number> {
		let sequence = input.sequence
		if (typeof sequence !== 'number') {
			const next = await this.d1
				.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM steps WHERE scenario_id = ?')
				.bind(input.scenarioId)
				.first<{ next: number }>()
			sequence = next?.next ?? 0
		}
		const result = await this.d1
			.prepare(`INSERT INTO steps (scenario_id, sequence, name, status, duration_ms, error, screenshot_r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.scenarioId,
				sequence,
				input.name,
				input.status,
				input.durationMs,
				input.error ?? null,
				input.screenshotKey ?? null,
				Date.now(),
			)
			.run()
		return Number(result.meta.last_row_id)
	}

	async attachScreenshot(stepId: number, key: string): Promise<void> {
		await this.d1
			.prepare('UPDATE steps SET screenshot_r2_key = ? WHERE id = ?')
			.bind(key, stepId)
			.run()
	}

	async listStepsForScenario(scenarioId: string): Promise<Step[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM steps WHERE scenario_id = ? ORDER BY sequence')
			.bind(scenarioId)
			.all<StepRow>()
		return results.map(toStep)
	}
}
