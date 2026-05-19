import { useEffect, useState } from 'react'

type Theme = 'system' | 'light' | 'dark'

const KEY = 'opice-theme'

const LABELS: Record<Theme, string> = {
	system: 'Auto',
	light: 'Daylight',
	dark: 'Lamplight',
}

function read(): Theme {
	try {
		const v = localStorage.getItem(KEY)
		return v === 'light' || v === 'dark' ? v : 'system'
	} catch {
		return 'system'
	}
}

function apply(theme: Theme) {
	const root = document.documentElement
	if (theme === 'system') {
		delete root.dataset['theme']
		try { localStorage.removeItem(KEY) } catch {}
	} else {
		root.dataset['theme'] = theme
		try { localStorage.setItem(KEY, theme) } catch {}
	}
}

export function ThemeSwitcher() {
	const [theme, setTheme] = useState<Theme>(read)

	useEffect(() => {
		apply(theme)
	}, [theme])

	return (
		<footer className="theme-switch" aria-label="Display">
			<span className="label">View</span>
			{(['system', 'light', 'dark'] as const).map(t => (
				<button
					key={t}
					type="button"
					className={`opt${theme === t ? ' active' : ''}`}
					onClick={() => setTheme(t)}
					aria-pressed={theme === t}
				>
					{LABELS[t]}
				</button>
			))}
		</footer>
	)
}
