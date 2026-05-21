import type { Capability, Project, Run, RunSource, RunStatus, Scenario, ScenarioStatus, Step, StepStatus, Token } from './types'

// A run with no ingest activity for this long is considered abandoned: the
// reaper finalizes it as 'incomplete', and reads display it that way even
// before the reaper runs (so local/lopata, where cron may not fire, is correct
// too). Generous — a slow scenario + screenshot upload must not trip it.
export const STALE_RUN_MS = 10 * 60 * 1000

// Internal D1 row shapes — snake_case as the migration defines.
interface ProjectRow {
	id: number
	slug: string
	name: string
	created_at: number
}

interface TokenRow {
	id: string
	token_hash: string
	capability: Capability
	project_id: number | null
	project_slug: string | null
	run_id: string | null
	label: string | null
	created_by: string | null
	created_at: number
	expires_at: number | null
	last_used_at: number | null
	revoked_at: number | null
}

interface RunRow {
	id: string
	project_id: number
	branch: string | null
	commit_sha: string | null
	status: ScenarioStatus
	total_scenarios: number
	passed_scenarios: number
	failed_scenarios: number
	source: RunSource | null
	started_at: number
	last_activity_at: number | null
	reaped_at: number | null
	finished_at: number | null
}

// Live per-run scenario tallies, joined into run reads so counts are correct
// mid-flight (the stored *_scenarios columns are only a snapshot written at
// finish — see finishRun). NULL when the run has no scenarios yet.
interface RunCountsRow {
	live_total: number | null
	live_passed: number | null
	live_failed: number | null
}

/**
 * Display status. The DB only ever stores running/passed/failed; a run reads as
 * 'incomplete' when the reaper gave up on it (reaped_at) or when it's still
 * 'running' but hasn't been touched within STALE_RUN_MS.
 */
function deriveStatus(r: RunRow, now: number): RunStatus {
	if (r.reaped_at != null) return 'incomplete'
	if (r.status === 'running' && r.finished_at == null) {
		const last = r.last_activity_at ?? r.started_at
		if (now - last > STALE_RUN_MS) return 'incomplete'
	}
	return r.status
}

interface ScenarioRow {
	id: string
	run_id: string
	name: string
	hash: string | null
	test_file: string | null
	scenario_file: string | null
	status: ScenarioStatus
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
	createdAt: r.created_at,
})

const toToken = (r: TokenRow): Token => ({
	id: r.id,
	tokenHash: r.token_hash,
	capability: r.capability,
	projectId: r.project_id,
	projectSlug: r.project_slug,
	runId: r.run_id,
	label: r.label,
	createdBy: r.created_by,
	createdAt: r.created_at,
	expiresAt: r.expires_at,
	lastUsedAt: r.last_used_at,
	revokedAt: r.revoked_at,
})

const toRun = (r: RunRow, counts: RunCountsRow, now: number): Run => ({
	id: r.id,
	projectId: r.project_id,
	branch: r.branch,
	commitSha: r.commit_sha,
	status: deriveStatus(r, now),
	source: r.source,
	// Always report live counts; the stored *_scenarios columns are a stale
	// snapshot until finish (and stay 0 for runs that never finished).
	totalScenarios: counts.live_total ?? 0,
	passedScenarios: counts.live_passed ?? 0,
	failedScenarios: counts.live_failed ?? 0,
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

	async createProject(input: { slug: string; name: string }): Promise<Project> {
		const createdAt = Date.now()
		const result = await this.d1
			.prepare('INSERT INTO projects (slug, name, created_at) VALUES (?, ?, ?)')
			.bind(input.slug, input.name, createdAt)
			.run()
		return {
			id: Number(result.meta.last_row_id),
			slug: input.slug,
			name: input.name,
			createdAt,
		}
	}

	async getProjectBySlug(slug: string): Promise<Project | null> {
		const row = await this.d1.prepare('SELECT * FROM projects WHERE slug = ?').bind(slug).first<ProjectRow>()
		return row ? toProject(row) : null
	}

	// ---- Tokens (machine + share credentials; see migration 0003) -----------

	/** Mint a token row. The caller hashes the secret; we never see plaintext. */
	async createToken(input: {
		id: string
		tokenHash: string
		capability: Capability
		projectId?: number | null
		runId?: string | null
		label?: string | null
		createdBy?: string | null
		expiresAt?: number | null
	}): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO tokens (id, token_hash, capability, project_id, run_id, label, created_by, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.id,
				input.tokenHash,
				input.capability,
				input.projectId ?? null,
				input.runId ?? null,
				input.label ?? null,
				input.createdBy ?? null,
				Date.now(),
				input.expiresAt ?? null,
			)
			.run()
	}

	/** Resolve a token by its secret's hash, joining the project slug for scope. */
	async getTokenByHash(tokenHash: string): Promise<Token | null> {
		const row = await this.d1
			.prepare(`SELECT t.*, p.slug AS project_slug
				FROM tokens t LEFT JOIN projects p ON p.id = t.project_id
				WHERE t.token_hash = ?`)
			.bind(tokenHash)
			.first<TokenRow>()
		return row ? toToken(row) : null
	}

	async getTokenById(id: string): Promise<Token | null> {
		const row = await this.d1
			.prepare(`SELECT t.*, p.slug AS project_slug
				FROM tokens t LEFT JOIN projects p ON p.id = t.project_id
				WHERE t.id = ?`)
			.bind(id)
			.first<TokenRow>()
		return row ? toToken(row) : null
	}

	/** List active (non-revoked) tokens for a project, or all when projectId is null. */
	async listTokens(projectId: number | null): Promise<Token[]> {
		const query = projectId == null
			? this.d1.prepare(`SELECT t.*, p.slug AS project_slug FROM tokens t
				LEFT JOIN projects p ON p.id = t.project_id
				WHERE t.revoked_at IS NULL ORDER BY t.created_at DESC`)
			: this.d1.prepare(`SELECT t.*, p.slug AS project_slug FROM tokens t
				LEFT JOIN projects p ON p.id = t.project_id
				WHERE t.revoked_at IS NULL AND t.project_id = ? ORDER BY t.created_at DESC`).bind(projectId)
		const { results } = await query.all<TokenRow>()
		return results.map(toToken)
	}

	async revokeToken(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
			.bind(Date.now(), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	/** Best-effort activity stamp for audit; failures are non-fatal to the request. */
	async touchToken(id: string): Promise<void> {
		await this.d1.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').bind(Date.now(), id).run()
	}

	async listProjects(): Promise<Project[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM projects ORDER BY created_at DESC')
			.all<ProjectRow>()
		return results.map(toProject)
	}

	async createRun(input: { id: string; projectId: number; branch?: string; commit?: string; source?: RunSource }): Promise<Run> {
		const startedAt = Date.now()
		await this.d1
			.prepare(`INSERT INTO runs (id, project_id, branch, commit_sha, status, source, started_at, last_activity_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`)
			.bind(input.id, input.projectId, input.branch ?? null, input.commit ?? null, input.source ?? null, startedAt, startedAt)
			.run()
		return {
			id: input.id,
			projectId: input.projectId,
			branch: input.branch ?? null,
			commitSha: input.commit ?? null,
			status: 'running',
			source: input.source ?? null,
			totalScenarios: 0,
			passedScenarios: 0,
			failedScenarios: 0,
			startedAt,
			finishedAt: null,
		}
	}

	async getRun(id: string): Promise<Run | null> {
		const row = await this.d1
			.prepare(`SELECT r.*,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id) AS live_total,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed') AS live_passed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'failed') AS live_failed
			FROM runs r WHERE r.id = ?`)
			.bind(id)
			.first<RunRow & RunCountsRow>()
		return row ? toRun(row, row, Date.now()) : null
	}

	async listRunsForProject(projectId: number, limit = 50): Promise<Run[]> {
		const { results } = await this.d1
			.prepare(`SELECT r.*,
				COUNT(s.id) AS live_total,
				COALESCE(SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END), 0) AS live_passed,
				COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS live_failed
			FROM runs r LEFT JOIN scenarios s ON s.run_id = r.id
			WHERE r.project_id = ?
			GROUP BY r.id
			ORDER BY r.started_at DESC LIMIT ?`)
			.bind(projectId, limit)
			.all<RunRow & RunCountsRow>()
		const now = Date.now()
		return results.map((row) => toRun(row, row, now))
	}

	/** Bump a run's activity clock so the reaper doesn't treat it as stale. */
	async touchRun(id: string): Promise<void> {
		await this.d1
			.prepare('UPDATE runs SET last_activity_at = ? WHERE id = ? AND finished_at IS NULL')
			.bind(Date.now(), id)
			.run()
	}

	/**
	 * Finalize runs abandoned mid-flight (the CLI's POST /finish never arrived —
	 * a crash, a kill, or a bare `bun test` that bypassed the wrapper). Marks
	 * them reaped so they read as 'incomplete'. Counts come from scenarios at
	 * read time, so we don't touch the snapshot columns here. Returns how many
	 * runs were reaped.
	 */
	async reapStaleRuns(now: number = Date.now(), staleMs: number = STALE_RUN_MS): Promise<number> {
		const result = await this.d1
			.prepare(`UPDATE runs SET reaped_at = ?, finished_at = COALESCE(finished_at, ?)
				WHERE reaped_at IS NULL AND finished_at IS NULL AND status = 'running'
				AND COALESCE(last_activity_at, started_at) < ?`)
			.bind(now, now, now - staleMs)
			.run()
		return result.meta.changes ?? 0
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
