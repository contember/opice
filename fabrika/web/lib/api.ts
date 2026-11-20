import { createClient } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

/** The operator surface (`/api`). A 401 sends the browser to sign in. */
export const api = createClient(contract, 'api', { bounceOnAuth: true })
