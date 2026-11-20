import { RpcError } from '@fabrika/app/client'

/** The message to show for a failed query or mutation. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** A refusal (4xx) won't change on retry; anything else gets one more try. */
export function shouldRetry(count: number, error: unknown): boolean {
	const status = error instanceof RpcError ? error.httpStatus : undefined
	return !(status !== undefined && status >= 400 && status < 500) && count < 1
}
