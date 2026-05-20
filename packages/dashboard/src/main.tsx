import { BuzolaProvider } from '@buzola/router'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { pageRegistry, routes } from './buzola.gen'
import { AuthGate } from './components/AuthGate'
import { RpcError } from './lib/rpc-client'
import { setAuthRequired } from './lib/auth-gate'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const queryClient = new QueryClient({
	// A 401 from any query flips the gate to the sign-in screen; a successful
	// query (e.g. a read-token visitor, or after signing in) clears it.
	queryCache: new QueryCache({
		onError: (error) => {
			if (error instanceof RpcError && error.type === 'auth') setAuthRequired(true)
		},
		onSuccess: () => setAuthRequired(false),
	}),
	defaultOptions: {
		queries: {
			staleTime: 5_000,
			// Don't keep retrying an unauthorized request — surface the gate fast.
			retry: (count, error) => !(error instanceof RpcError && error.type === 'auth') && count < 1,
		},
	},
})

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<AuthGate>
				<BuzolaProvider routes={routes} pageRegistry={pageRegistry} />
			</AuthGate>
		</QueryClientProvider>
	</StrictMode>,
)
