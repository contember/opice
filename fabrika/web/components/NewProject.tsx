import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../lib/api'
import { errorMessage } from '../lib/errors'

type Created = Awaited<ReturnType<typeof api.projects.create>>

/**
 * "New project" — create a project from the dashboard and show the DSN it reports with. The key in it comes from an
 * installation administrator (the platform console), so the DSN is a template with the project's id.
 */
export function NewProject() {
	const queryClient = useQueryClient()
	const [open, setOpen] = useState(false)
	const [slug, setSlug] = useState('')
	const [name, setName] = useState('')
	const [created, setCreated] = useState<Created | null>(null)

	const mutation = useMutation({
		mutationFn: () => api.projects.create({ slug: slug.trim(), name: name.trim() }),
		onSuccess: (result) => {
			setCreated(result)
			void queryClient.invalidateQueries({ queryKey: ['projects.list'] })
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
		return (
			<div className="new-project-panel">
				<div className="np-head">
					<h2>✓ Created “{created.name}”</h2>
					<button type="button" className="btn-ghost" onClick={reset}>Done</button>
				</div>
				<label className="np-label">Its DSN, once you have a key</label>
				<CopyBlock value={`OPICE_DSN=https://<service key>@${host}/${created.id}`} />
				<p className="np-hint">
					An installation administrator mints the <code>px_</code> service key in the platform console (Access →
					Credentials) and grants <code>report.write</code> in this project. Put the DSN in your project's{' '}
					<code>.env</code> and as a CI secret.
				</p>
			</div>
		)
	}

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
			{mutation.error && <p className="np-error">{errorMessage(mutation.error)}</p>}
			<button type="submit" className="btn-primary" disabled={mutation.isPending}>
				{mutation.isPending ? 'Creating…' : 'Create project'}
			</button>
		</form>
	)
}

export function CopyBlock({ value }: { value: string }) {
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
