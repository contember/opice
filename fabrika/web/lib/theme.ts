// Apply the persisted theme before the first render (an inline script would need a CSP exception).
try {
	const theme = localStorage.getItem('opice-theme')
	if (theme === 'light' || theme === 'dark') document.documentElement.dataset['theme'] = theme
} catch {
	// Storage blocked: the default theme stays.
}
