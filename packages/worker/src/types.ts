export interface Project {
	id: number
	slug: string
	name: string
	api_key_hash: string
	created_at: number
}

export interface Run {
	id: string
	project_id: number
	branch: string | null
	commit_sha: string | null
	status: 'running' | 'passed' | 'failed'
	total_scenarios: number
	passed_scenarios: number
	failed_scenarios: number
	started_at: number
	finished_at: number | null
}

export interface Scenario {
	id: string
	run_id: string
	name: string
	hash: string | null
	status: 'running' | 'passed' | 'failed'
	duration_ms: number | null
	started_at: number
	finished_at: number | null
}

export interface Step {
	id: number
	scenario_id: string
	sequence: number
	name: string
	status: 'passed' | 'failed'
	duration_ms: number
	error: string | null
	screenshot_r2_key: string | null
	created_at: number
}
