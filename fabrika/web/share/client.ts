import { createClient, shareKey } from '@fabrika/app/client'
import { contract } from '../../fabrika.contract'

/** The share link mount's client, or `null` when the page was opened without a link key. */
export function shareClient() {
	const key = shareKey()
	return key === null ? null : createClient(contract, 'shared', { key })
}

export type ShareClient = NonNullable<ReturnType<typeof shareClient>>
