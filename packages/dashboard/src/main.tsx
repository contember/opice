import { BuzolaProvider } from '@buzola/router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { pageRegistry, routes } from './buzola.gen'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			retry: 1,
		},
	},
})

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
		</QueryClientProvider>
	</StrictMode>,
)
