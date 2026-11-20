import '../lib/theme'
import '../styles.css'
import { FabrikaProvider } from '@fabrika/app/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { shouldRetry } from '../lib/errors'
import { shareClient } from './client'
import { NoLink, ShareRun } from './ShareRun'

const queryClient = new QueryClient({
	defaultOptions: { queries: { staleTime: 60_000, retry: shouldRetry } },
})

const client = shareClient()
const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				{client === null ? <NoLink /> : (
					<FabrikaProvider clients={[client]} spa="/s">
						<ShareRun client={client} />
					</FabrikaProvider>
				)}
			</QueryClientProvider>
		</StrictMode>,
	)
}
