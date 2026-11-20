import './lib/theme'
import './styles.css'
import { FabrikaProvider } from '@fabrika/app/react'
import { BuzolaProvider } from '@buzola/router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { pageRegistry, routes } from './routes'
import { api } from './lib/api'
import { shouldRetry } from './lib/errors'

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 5_000, retry: shouldRetry } },
})

const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<FabrikaProvider clients={[api]}>
				<QueryClientProvider client={queryClient}>
					<BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
				</QueryClientProvider>
			</FabrikaProvider>
		</StrictMode>,
	)
}
