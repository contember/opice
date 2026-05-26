import type { Capability, Project, Run, RunSource, RunStatus, RunWithProject, Scenario, ScenarioStatus, Step, StepKind, StepStatus, Token } from './types'

// Step statuses that mark a tolerated known failure (step.fixme). A scenario
// carrying one of these (and no hard failure / no pending step) reads as
// 'warning', not 'passed'.
const WARNING_STEP_SQL = `status IN ('fixme', 'fixmepass')`
// A pending step is a phase-1 skeleton stub that never ran. A scenario carrying
// one (and no hard failure) reads as 'incomplete' — it outranks 'warning'.
const PENDING_STEP_SQL = `status = 'pending'`

// EXISTS predicates over a scenario `s`, reused across the run-count queries.
const HAS_PENDING = `EXISTS(SELECT 1 FROM steps st WHERE st.scenario_id = s.id AND st.${PENDING_STEP_SQL})`
const HAS_WARNING = `EXISTS(SELECT 1 FROM steps st WHERE st.scenario_id = s.id AND st.${WARNING_STEP_SQL})`

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
	// Passed scenarios that carry a tolerated fixme step (and no pending step)
	// → shown as warnings.
	live_warning: number | null
	// Passed scenarios that carry a pending step → shown as incomplete.
	live_incomplete: number | null
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
	feature: string | null
	seeds: string | null
	roles: string | null
	status: ScenarioStatus
	duration_ms: number | null
	started_at: number
	finished_at: number | null
	// Computed per read: 1 when the scenario carries a tolerated fixme step /
	// a pending step. Absent on `SELECT *` reads where the state doesn't matter.
	has_warning?: number
	has_pending?: number
}

interface StepRow {
	id: number
	scenario_id: string
	sequence: number
	kind: StepKind
	name: string
	status: StepStatus
	duration_ms: number
	error: string | null
	intent: string | null
	reason: string | null
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

const toRun = (r: RunRow, counts: RunCountsRow, now: number): Run => {
	const base = deriveStatus(r, now)
	const warning = counts.live_warning ?? 0
	const incomplete = counts.live_incomplete ?? 0
	// Overlay on a passed run, in priority order: a pending (unauthored) step →
	// 'incomplete'; else a tolerated fixme step → 'warning' (amber). A hard
	// fail / running / a reaped-or-stale 'incomplete' from deriveStatus all win.
	const status: RunStatus = base === 'passed'
		? (incomplete > 0 ? 'incomplete' : warning > 0 ? 'warning' : 'passed')
		: base
	return {
		id: r.id,
		projectId: r.project_id,
		branch: r.branch,
		commitSha: r.commit_sha,
		status,
		source: r.source,
		// Always report live counts; the stored *_scenarios columns are a stale
		// snapshot until finish (and stay 0 for runs that never finished).
		totalScenarios: counts.live_total ?? 0,
		passedScenarios: counts.live_passed ?? 0,
		failedScenarios: counts.live_failed ?? 0,
		warningScenarios: warning,
		incompleteScenarios: incomplete,
		startedAt: r.started_at,
		finishedAt: r.finished_at,
	}
}

const parseStringArray = (json: string | null): string[] => {
	if (!json) return []
	try {
		const parsed = JSON.parse(json)
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
	} catch {
		return []
	}
}

const toScenario = (r: ScenarioRow): Scenario => ({
	id: r.id,
	runId: r.run_id,
	name: r.name,
	hash: r.hash,
	testFile: r.test_file,
	scenarioFile: r.scenario_file,
	feature: r.feature,
	seeds: parseStringArray(r.seeds),
	roles: parseStringArray(r.roles),
	// Display overlay on a passed scenario, in priority order: a pending step →
	// 'incomplete'; else a tolerated fixme step → 'warning'.
	status: r.status === 'passed'
		? (r.has_pending ? 'incomplete' : r.has_warning ? 'warning' : 'passed')
		: r.status,
	durationMs: r.duration_ms,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
})

const toStep = (r: StepRow): Step => ({
	id: r.id,
	scenarioId: r.scenario_id,
	sequence: r.sequence,
	kind: r.kind,
	name: r.name,
	status: r.status,
	durationMs: r.duration_ms,
	error: r.error,
	intent: r.intent,
	reason: r.reason,
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
			warningScenarios: 0,
			incompleteScenarios: 0,
			startedAt,
			finishedAt: null,
		}
	}

	async getRun(id: string): Promise<Run | null> {
		const row = await this.d1
			.prepare(`SELECT r.*,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id) AS live_total,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed') AS live_passed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'failed') AS live_failed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed'
					AND ${HAS_WARNING} AND NOT ${HAS_PENDING}) AS live_warning,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed'
					AND ${HAS_PENDING}) AS live_incomplete
			FROM runs r WHERE r.id = ?`)
			.bind(id)
			.first<RunRow & RunCountsRow>()
		return row ? toRun(row, row, Date.now()) : null
	}

	async listRunsForProject(projectId: number, opts: { limit: number; offset: number }): Promise<{ runs: Run[]; hasMore: boolean }> {
		// Fetch one extra row to learn whether a further page exists without a
		// separate COUNT query.
		const { results } = await this.d1
			.prepare(`SELECT r.*,
				COUNT(s.id) AS live_total,
				COALESCE(SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END), 0) AS live_passed,
				COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS live_failed,
				COALESCE(SUM(CASE WHEN s.status = 'passed'
					AND ${HAS_WARNING} AND NOT ${HAS_PENDING} THEN 1 ELSE 0 END), 0) AS live_warning,
				COALESCE(SUM(CASE WHEN s.status = 'passed'
					AND ${HAS_PENDING} THEN 1 ELSE 0 END), 0) AS live_incomplete
			FROM runs r LEFT JOIN scenarios s ON s.run_id = r.id
			WHERE r.project_id = ?
			GROUP BY r.id
			ORDER BY r.started_at DESC LIMIT ? OFFSET ?`)
			.bind(projectId, opts.limit + 1, opts.offset)
			.all<RunRow & RunCountsRow>()
		const now = Date.now()
		const hasMore = results.length > opts.limit
		return { runs: results.slice(0, opts.limit).map((row) => toRun(row, row, now)), hasMore }
	}

	/** Cross-project run feed, newest first, each row carrying its project's slug + name. */
	async listAllRuns(opts: { limit: number; offset: number }): Promise<{ runs: RunWithProject[]; hasMore: boolean }> {
		const { results } = await this.d1
			.prepare(`SELECT r.*, p.slug AS project_slug, p.name AS project_name,
				COUNT(s.id) AS live_total,
				COALESCE(SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END), 0) AS live_passed,
				COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS live_failed,
				COALESCE(SUM(CASE WHEN s.status = 'passed'
					AND ${HAS_WARNING} AND NOT ${HAS_PENDING} THEN 1 ELSE 0 END), 0) AS live_warning,
				COALESCE(SUM(CASE WHEN s.status = 'passed'
					AND ${HAS_PENDING} THEN 1 ELSE 0 END), 0) AS live_incomplete
			FROM runs r JOIN projects p ON p.id = r.project_id
			LEFT JOIN scenarios s ON s.run_id = r.id
			GROUP BY r.id
			ORDER BY r.started_at DESC LIMIT ? OFFSET ?`)
			.bind(opts.limit + 1, opts.offset)
			.all<RunRow & RunCountsRow & { project_slug: string; project_name: string }>()
		const now = Date.now()
		const hasMore = results.length > opts.limit
		const runs = results.slice(0, opts.limit).map((row) => ({
			...toRun(row, row, now),
			projectSlug: row.project_slug,
			projectName: row.project_name,
		}))
		return { runs, hasMore }
	}

	/**
	 * The "headline" run per project for dashboard summaries: the most recent run
	 * on `main`/`master`, falling back to the most recent run on any branch when
	 * the project has never reported a main/master run. One row per project.
	 */
	async listLastRunByProject(): Promise<Run[]> {
		const { results } = await this.d1
			.prepare(`WITH ranked AS (
				SELECT r.id, ROW_NUMBER() OVER (
					PARTITION BY r.project_id
					ORDER BY (CASE WHEN r.branch IN ('main', 'master') THEN 0 ELSE 1 END), r.started_at DESC
				) AS rn
				FROM runs r
			)
			SELECT r.*,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id) AS live_total,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed') AS live_passed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'failed') AS live_failed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed'
					AND ${HAS_WARNING} AND NOT ${HAS_PENDING}) AS live_warning,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed'
					AND ${HAS_PENDING}) AS live_incomplete
			FROM runs r JOIN ranked ON ranked.id = r.id AND ranked.rn = 1`)
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
		feature?: string
		seeds?: string[]
		roles?: string[]
	}): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO scenarios (id, run_id, name, hash, test_file, scenario_file, feature, seeds, roles, status, started_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
			.bind(
				input.id,
				input.runId,
				input.name,
				input.hash ?? null,
				input.testFile ?? null,
				input.scenarioFile ?? null,
				input.feature ?? null,
				input.seeds && input.seeds.length > 0 ? JSON.stringify(input.seeds) : null,
				input.roles && input.roles.length > 0 ? JSON.stringify(input.roles) : null,
				Date.now(),
			)
			.run()
	}

	async getScenario(id: string): Promise<Scenario | null> {
		const row = await this.d1
			.prepare(`SELECT s.*,
				${HAS_WARNING} AS has_warning,
				${HAS_PENDING} AS has_pending
			FROM scenarios s WHERE s.id = ?`)
			.bind(id)
			.first<ScenarioRow>()
		return row ? toScenario(row) : null
	}

	async finishScenario(input: { id: string; status: ScenarioStatus; durationMs: number }): Promise<void> {
		await this.d1
			.prepare(`UPDATE scenarios SET status = ?, duration_ms = ?, finished_at = ? WHERE id = ?`)
			.bind(input.status, input.durationMs, Date.now(), input.id)
			.run()
	}

	async listScenariosForRun(runId: string): Promise<Scenario[]> {
		const { results } = await this.d1
			.prepare(`SELECT s.*,
				${HAS_WARNING} AS has_warning,
				${HAS_PENDING} AS has_pending
			FROM scenarios s WHERE s.run_id = ? ORDER BY s.started_at`)
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
		kind?: StepKind
		name: string
		status: StepStatus
		durationMs: number
		error?: string
		intent?: string
		reason?: string
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
			.prepare(`INSERT INTO steps (scenario_id, sequence, kind, name, status, duration_ms, error, intent, reason, screenshot_r2_key, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.scenarioId,
				sequence,
				input.kind ?? 'step',
				input.name,
				input.status,
				input.durationMs,
				input.error ?? null,
				input.intent ?? null,
				input.reason ?? null,
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
