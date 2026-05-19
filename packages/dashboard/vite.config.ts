import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			'/rpc': 'http://localhost:8787',
			'/api/v1': 'http://localhost:8787',
			'/screenshots': 'http://localhost:8787',
		},
	},
})
