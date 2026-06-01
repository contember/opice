import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { rpc } from '../lib/client'
import { RpcError } from '../lib/rpc-client'

interface Created {
	slug: string
	name: string
	apiKey: string
	readApiKey: string
}

/**
 * "New project" — create a project from the dashboard and surface the one-time
 * onboarding payload: an `OPICE_DSN` to drop into `.env` and a copy-paste
 * prompt that points Claude Code at `/install.md` to finish the integration.
 */
export function NewProject() {
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)
	const [slug, setSlug] = useState('')
	const [name, setName] = useState('')
	const [created, setCreated] = useState<Created | null>(null)

	const mutation = useMutation({
		mutationFn: () => rpc.projects.create({ slug: slug.trim(), name: name.trim() }),
		onSuccess: (result) => {
			setCreated(result)
			queryClient.invalidateQueries({ queryKey: ['projects.list'] })
		},
	})

	function reset() {
		setOpen(false)
		setCreated(null)
		setSlug('')
		setName('')
		mutation.reset()
	}

	if (!open) {
		return (
			<button type="button" className="btn-primary" onClick={() => setOpen(true)}>
				+ New project
			</button>
		)
	}

	if (created) {
		const host = window.location.host
		const dsn = `OPICE_DSN=https://${created.apiKey}@${host}/${created.slug}`
		const readDsn = `OPICE_READ_DSN=https://${created.readApiKey}@${host}/${created.slug}`
		const prompt = `Fetch instructions from ${window.location.origin}/install.md`
		return (
			<div className="new-project-panel">
				<div className="np-head">
					<h2>✓ Created “{created.name}”</h2>
					<button type="button" className="btn-ghost" onClick={reset}>Done</button>
				</div>
				<p className="np-warn">Shown once — store these now (they embed secret keys that can't be recovered).</p>

				<label className="np-label">1. Save both to your project's <code>.env</code></label>
				<CopyBlock value={dsn} />
				<p className="np-hint">Write key — CI and local <code>opice test</code> stream results with it.</p>
				<CopyBlock value={readDsn} />
				<p className="np-hint">Read key — lets the authoring agent pull this project's results back (e.g. <code>opice failures</code>, re-eval). Scoped to this project, read-only.</p>

				<label className="np-label">2. Run Claude Code in your project with this prompt</label>
				<CopyBlock value={prompt} />

				<p className="np-hint">
					It fetches the integration guide and walks the kickoff — config, CI workflow,
					skills, the CI secret, and your first scenario.
				</p>
			</div>
		)
	}

	const errorMessage = mutation.error
		? mutation.error instanceof RpcError
			? mutation.error.message
			: (mutation.error as Error).message
		: null

	return (
		<form
			className="new-project-panel"
			onSubmit={(e) => {
				e.preventDefault()
				mutation.mutate()
			}}
		>
			<div className="np-head">
				<h2>New project</h2>
				<button type="button" className="btn-ghost" onClick={reset}>Cancel</button>
			</div>
			<label className="np-field">
				<span>Slug</span>
				<input
					value={slug}
					onChange={(e) => setSlug(e.target.value)}
					placeholder="my-app"
					pattern="[a-z0-9][a-z0-9-]*"
					title="lowercase letters, numbers and dashes"
					autoFocus
					required
				/>
			</label>
			<label className="np-field">
				<span>Name</span>
				<input value={name} onChange={(e) => setName(e.target.value)} placeholder="My App" required />
			</label>
			{errorMessage && <p className="np-error">{errorMessage}</p>}
			<button type="submit" className="btn-primary" disabled={mutation.isPending}>
				{mutation.isPending ? 'Creating…' : 'Create project'}
			</button>
		</form>
	)
}

function CopyBlock({ value }: { value: string }) {
	const [copied, setCopied] = useState(false)
	async function copy() {
		try {
			await navigator.clipboard.writeText(value)
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		} catch {
			// Clipboard blocked (e.g. non-secure context) — the value is still selectable.
		}
	}
	return (
		<div className="copy-block">
			<code>{value}</code>
			<button type="button" className="copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
		</div>
	)
}
