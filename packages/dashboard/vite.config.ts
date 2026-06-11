import { buzolaPlugin } from '@buzola/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		buzolaPlugin(),
		react(),
	],
	server: {
		port: 18182,
		proxy: {
			'/rpc': 'http://localhost:18181',
			'/api/v1': 'http://localhost:18181',
			'/screenshots': 'http://localhost:18181',
			// Public share surface — only the data paths proxy to the Worker. The
			// `/s/p/...` SPA shell stays on vite (HMR); in prod the Worker serves it
			// after the `?token=`→cookie exchange (run_worker_first).
			'/s/rpc': 'http://localhost:18181',
			'/s/screenshots': 'http://localhost:18181',
			// DEV-only operator persona switch (sets the FakeIamClient cookie on the worker origin).
			'/__dev': 'http://localhost:18181',
		},
	},
})
