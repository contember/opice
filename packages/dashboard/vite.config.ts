import { buzolaPlugin } from '@buzola/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		buzolaPlugin(),
		react(),
	],
	server: {
		port: 5174,
		proxy: {
			'/rpc': 'http://localhost:8788',
			'/api/v1': 'http://localhost:8788',
			'/screenshots': 'http://localhost:8788',
		},
	},
})
