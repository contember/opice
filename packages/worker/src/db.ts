import type { CapabilityKind, CapabilityRecord, Project, Run, RunSource, RunStatus, RunWithProject, Scenario, ScenarioStatus, Step, StepKind, StepStatus } from './types'

// Step statuses that mark a tolerated known failure (step.fixme). A scenario
// carrying one of these (and no hard failure / no pending step) reads as
// 'warning', not 'passed'.
const WARNING_STEP_SQL = `status IN ('fixme', 'fixmepass')`
// A pending step is a phase-1 skeleton stub that never ran. A scenario carrying
// one (and no hard failure) reads as 'incomplete' — it outranks 'warning'.
const PENDING_STEP_SQL = `status = 'pending'`

// Steps of a scenario's *final* attempt. Retries keep earlier attempts' steps
// in the table (forensics), but status overlays and step reads must consider
// only the attempt that decided the scenario — a 'fixme'/'pending' step from a
// discarded earlier attempt mustn't colour the final result.
const LATEST_ATTEMPT_SQL = `st.attempt = (SELECT MAX(attempt) FROM steps WHERE scenario_id = s.id)`

// EXISTS predicates over a scenario `s`, reused across the run-count queries.
const HAS_PENDING = `EXISTS(SELECT 1 FROM steps st WHERE st.scenario_id = s.id AND ${LATEST_ATTEMPT_SQL} AND st.${PENDING_STEP_SQL})`
const HAS_WARNING = `EXISTS(SELECT 1 FROM steps st WHERE st.scenario_id = s.id AND ${LATEST_ATTEMPT_SQL} AND st.${WARNING_STEP_SQL})`

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


interface RunRow {
	id: string
	project_id: number
	branch: string | null
	commit_sha: string | null
	status: ScenarioStatus
	tier: string | null
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
	// Scenarios the tier filter excluded (skipped_at set) → shown as skipped,
	// kept out of live_total.
	live_skipped: number | null
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
	tier: string | null
	status: ScenarioStatus
	duration_ms: number | null
	attempts: number
	started_at: number
	finished_at: number | null
	skipped_at: number | null
	skip_reason: string | null
	video_r2_key: string | null
	// Computed per read: 1 when the scenario carries a tolerated fixme step /
	// a pending step. Absent on `SELECT *` reads where the state doesn't matter.
	has_warning?: number
	has_pending?: number
}

interface StepRow {
	id: number
	scenario_id: string
	attempt: number
	sequence: number
	kind: StepKind
	name: string
	status: StepStatus
	duration_ms: number
	error: string | null
	intent: string | null
	manual: string | null
	reason: string | null
	screenshot_r2_key: string | null
	screenshot_failed: number
	created_at: number
}

const toProject = (r: ProjectRow): Project => ({
	id: r.id,
	slug: r.slug,
	name: r.name,
	createdAt: r.created_at,
})

interface CapabilityRow {
	id: string
	project_id: number
	run_id: string | null
	kind: CapabilityKind
	label: string | null
	client_id: string | null
	created_by: string | null
	created_at: number
	expires_at: number | null
	revoked_at: number | null
}

const toCapability = (r: CapabilityRow): CapabilityRecord => ({
	id: r.id,
	projectId: r.project_id,
	runId: r.run_id,
	kind: r.kind,
	label: r.label,
	clientId: r.client_id,
	createdBy: r.created_by,
	createdAt: r.created_at,
	expiresAt: r.expires_at,
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
		tier: r.tier,
		// Always report live counts; the stored *_scenarios columns are a stale
		// snapshot until finish (and stay 0 for runs that never finished).
		totalScenarios: counts.live_total ?? 0,
		passedScenarios: counts.live_passed ?? 0,
		failedScenarios: counts.live_failed ?? 0,
		warningScenarios: warning,
		incompleteScenarios: incomplete,
		skippedScenarios: counts.live_skipped ?? 0,
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
	tier: r.tier,
	skipReason: r.skip_reason,
	videoKey: r.video_r2_key,
	// Display status: a skipped scenario (tier filter) wins — it never ran, so no
	// step overlay applies. Otherwise overlay a passed scenario, in priority
	// order: a pending step → 'incomplete'; else a tolerated fixme step → 'warning'.
	status: r.skipped_at != null
		? 'skipped'
		: r.status === 'passed'
			? (r.has_pending ? 'incomplete' : r.has_warning ? 'warning' : 'passed')
			: r.status,
	durationMs: r.duration_ms,
	attempts: r.attempts,
	startedAt: r.started_at,
	finishedAt: r.finished_at,
})

const toStep = (r: StepRow): Step => ({
	id: r.id,
	scenarioId: r.scenario_id,
	attempt: r.attempt,
	sequence: r.sequence,
	kind: r.kind,
	name: r.name,
	status: r.status,
	durationMs: r.duration_ms,
	error: r.error,
	intent: r.intent,
	manual: r.manual,
	reason: r.reason,
	screenshotKey: r.screenshot_r2_key,
	screenshotFailed: r.screenshot_failed !== 0,
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

	async getProjectById(id: number): Promise<Project | null> {
		const row = await this.d1.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>()
		return row ? toProject(row) : null
	}

	// ---- Capabilities (local mirror of propustka capability tokens; migration 0007) ----

	/**
	 * Record a freshly-issued credential. `id` is the propustka handle: the service PRINCIPAL id
	 * for ingest/read service tokens (with `clientId` set), or the capability token id for shares.
	 */
	async createCapability(input: {
		id: string
		projectId: number
		runId?: string | null
		kind: CapabilityKind
		label?: string | null
		clientId?: string | null
		createdBy?: string | null
		expiresAt?: number | null
	}): Promise<void> {
		await this.d1
			.prepare(`INSERT INTO capabilities (id, project_id, run_id, kind, label, client_id, created_by, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.id,
				input.projectId,
				input.runId ?? null,
				input.kind,
				input.label ?? null,
				input.clientId ?? null,
				input.createdBy ?? null,
				Date.now(),
				input.expiresAt ?? null,
			)
			.run()
	}

	/** Live (non-revoked) run-share capabilities for a run, newest first. */
	async listRunShares(runId: string): Promise<CapabilityRecord[]> {
		const { results } = await this.d1
			.prepare(`SELECT * FROM capabilities WHERE run_id = ? AND kind = 'share' AND revoked_at IS NULL ORDER BY created_at DESC`)
			.bind(runId)
			.all<CapabilityRow>()
		return results.map(toCapability)
	}

	/** Live (non-revoked) capabilities for a project (optionally of one kind), newest first. */
	async listProjectCapabilities(projectId: number, kind?: CapabilityKind): Promise<CapabilityRecord[]> {
		const query = kind
			? this.d1.prepare('SELECT * FROM capabilities WHERE project_id = ? AND kind = ? AND revoked_at IS NULL ORDER BY created_at DESC').bind(projectId, kind)
			: this.d1.prepare('SELECT * FROM capabilities WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').bind(projectId)
		const { results } = await query.all<CapabilityRow>()
		return results.map(toCapability)
	}

	async getCapability(id: string): Promise<CapabilityRecord | null> {
		const row = await this.d1.prepare('SELECT * FROM capabilities WHERE id = ?').bind(id).first<CapabilityRow>()
		return row ? toCapability(row) : null
	}

	/** Mark a capability revoked in the mirror (the hard revoke is `iam.revokeCapability`). */
	async markCapabilityRevoked(id: string): Promise<boolean> {
		const result = await this.d1
			.prepare('UPDATE capabilities SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
			.bind(Date.now(), id)
			.run()
		return (result.meta.changes ?? 0) > 0
	}

	async listProjects(): Promise<Project[]> {
		const { results } = await this.d1
			.prepare('SELECT * FROM projects ORDER BY created_at DESC')
			.all<ProjectRow>()
		return results.map(toProject)
	}

	async createRun(input: { id: string; projectId: number; branch?: string; commit?: string; source?: RunSource; tier?: string }): Promise<Run> {
		const startedAt = Date.now()
		await this.d1
			.prepare(`INSERT INTO runs (id, project_id, branch, commit_sha, status, source, tier, started_at, last_activity_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
			.bind(input.id, input.projectId, input.branch ?? null, input.commit ?? null, input.source ?? null, input.tier ?? null, startedAt, startedAt)
			.run()
		return {
			id: input.id,
			projectId: input.projectId,
			branch: input.branch ?? null,
			commitSha: input.commit ?? null,
			status: 'running',
			source: input.source ?? null,
			tier: input.tier ?? null,
			totalScenarios: 0,
			passedScenarios: 0,
			failedScenarios: 0,
			warningScenarios: 0,
			incompleteScenarios: 0,
			skippedScenarios: 0,
			startedAt,
			finishedAt: null,
		}
	}

	async getRun(id: string): Promise<Run | null> {
		const row = await this.d1
			.prepare(`SELECT r.*,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.skipped_at IS NULL) AS live_total,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed') AS live_passed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'failed') AS live_failed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.skipped_at IS NOT NULL) AS live_skipped,
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
				COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.skipped_at IS NULL THEN 1 ELSE 0 END), 0) AS live_total,
				COALESCE(SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END), 0) AS live_passed,
				COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS live_failed,
				COALESCE(SUM(CASE WHEN s.skipped_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS live_skipped,
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
				COALESCE(SUM(CASE WHEN s.id IS NOT NULL AND s.skipped_at IS NULL THEN 1 ELSE 0 END), 0) AS live_total,
				COALESCE(SUM(CASE WHEN s.status = 'passed' THEN 1 ELSE 0 END), 0) AS live_passed,
				COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS live_failed,
				COALESCE(SUM(CASE WHEN s.skipped_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS live_skipped,
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
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.skipped_at IS NULL) AS live_total,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'passed') AS live_passed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.status = 'failed') AS live_failed,
				(SELECT COUNT(*) FROM scenarios s WHERE s.run_id = r.id AND s.skipped_at IS NOT NULL) AS live_skipped,
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
		// Derive final status + counts from the run's scenarios. `grand` counts ALL
		// scenarios (incl. skipped); `executed`/passed/failed exclude skipped.
		const counts = await this.d1
			.prepare(`SELECT
				COUNT(*) AS grand,
				SUM(CASE WHEN skipped_at IS NULL THEN 1 ELSE 0 END) AS executed,
				SUM(CASE WHEN status = 'passed' AND skipped_at IS NULL THEN 1 ELSE 0 END) AS passed,
				SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
			FROM scenarios WHERE run_id = ?`)
			.bind(id)
			.first<{ grand: number; executed: number; passed: number; failed: number }>()
		const grand = counts?.grand ?? 0
		const executed = counts?.executed ?? 0
		const passed = counts?.passed ?? 0
		const failed = counts?.failed ?? 0
		// Fail on a hard failure, or on a truly empty run (nothing reported at all —
		// a load error, say). A run that reported ONLY skipped scenarios (the tier
		// matched nothing executable) is not a failure: grand > 0 keeps it green.
		const status: RunStatus = failed > 0 || grand === 0 ? 'failed' : 'passed'
		await this.d1
			.prepare(`UPDATE runs SET status = ?, total_scenarios = ?, passed_scenarios = ?, failed_scenarios = ?, finished_at = ? WHERE id = ?`)
			.bind(status, executed, passed, failed, Date.now(), id)
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
		/** Declared tier (critical | standard | extended). */
		tier?: string
		/** True for a scenario the tier filter excluded — created already-finished as skipped. */
		skipped?: boolean
		/** Why it was skipped (only with `skipped`). */
		skipReason?: string
	}): Promise<void> {
		// A skipped scenario never runs: it's terminal on creation (skipped_at +
		// finished_at set now), keeping its stored 'running' status — db reads map
		// skipped_at to the 'skipped' display status (like runs/reaped_at).
		const now = Date.now()
		const skippedAt = input.skipped ? now : null
		await this.d1
			.prepare(`INSERT INTO scenarios (id, run_id, name, hash, test_file, scenario_file, feature, seeds, roles, tier, status, started_at, skipped_at, skip_reason, finished_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`)
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
				input.tier ?? null,
				now,
				skippedAt,
				input.skipped ? (input.skipReason ?? null) : null,
				skippedAt,
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

	async finishScenario(input: { id: string; status: ScenarioStatus; durationMs: number; attempts?: number }): Promise<void> {
		// `attempts` defaults to 1 (column default) for older clients that don't
		// report it; clamp to >= 1 so a flaky badge keys cleanly off attempts > 1.
		const attempts = typeof input.attempts === 'number' && input.attempts >= 1 ? input.attempts : 1
		await this.d1
			.prepare(`UPDATE scenarios SET status = ?, duration_ms = ?, attempts = ?, finished_at = ? WHERE id = ?`)
			.bind(input.status, input.durationMs, attempts, Date.now(), input.id)
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
		 * Which retry attempt (0-based) produced this step. Steps from earlier
		 * attempts are retained but not displayed (see LATEST_ATTEMPT_SQL).
		 * Older clients omit it; defaults to 0 (the column default).
		 */
		attempt?: number
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
		manual?: string
		reason?: string
		screenshotKey?: string
	}): Promise<number> {
		const attempt = typeof input.attempt === 'number' && input.attempt >= 0 ? input.attempt : 0
		let sequence = input.sequence
		if (typeof sequence !== 'number') {
			const next = await this.d1
				.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM steps WHERE scenario_id = ? AND attempt = ?')
				.bind(input.scenarioId, attempt)
				.first<{ next: number }>()
			sequence = next?.next ?? 0
		}
		const result = await this.d1
			.prepare(`INSERT INTO steps (scenario_id, attempt, sequence, kind, name, status, duration_ms, error, intent, manual, reason, screenshot_r2_key, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				input.scenarioId,
				attempt,
				sequence,
				input.kind ?? 'step',
				input.name,
				input.status,
				input.durationMs,
				input.error ?? null,
				input.intent ?? null,
				input.manual ?? null,
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

	/** Point a scenario at its uploaded walkthrough video (R2 key). See ingest `uploadVideo`. */
	async attachVideo(scenarioId: string, key: string): Promise<void> {
		await this.d1
			.prepare('UPDATE scenarios SET video_r2_key = ? WHERE id = ?')
			.bind(key, scenarioId)
			.run()
	}

	/**
	 * Flag that a step's screenshot was captured but its upload to R2 failed —
	 * the step row is kept (the upload is best-effort), but the dashboard can show
	 * the gap rather than rendering it as "no screenshot". See ingest `createStep`.
	 */
	async markScreenshotFailed(stepId: number): Promise<void> {
		await this.d1
			.prepare('UPDATE steps SET screenshot_failed = 1 WHERE id = ?')
			.bind(stepId)
			.run()
	}

	async listStepsForScenario(scenarioId: string): Promise<Step[]> {
		// Only the final attempt's steps are displayed — earlier attempts of a
		// retried scenario are kept for forensics but would otherwise show as
		// duplicate, stale (often failed) rows in the timeline.
		const { results } = await this.d1
			.prepare(`SELECT * FROM steps WHERE scenario_id = ?
				AND attempt = (SELECT MAX(attempt) FROM steps WHERE scenario_id = ?)
				ORDER BY sequence`)
			.bind(scenarioId, scenarioId)
			.all<StepRow>()
		return results.map(toStep)
	}
}
