import type { AnyProcedure, AnyRouter, RouterDef } from './types'

export class RpcDispatchError extends Error {
	readonly type: string
	readonly httpStatus: number
	readonly issues?: unknown

	constructor(args: { type: string; message: string; httpStatus: number; issues?: unknown }) {
		super(args.message)
		this.name = 'RpcDispatchError'
		this.type = args.type
		this.httpStatus = args.httpStatus
		this.issues = args.issues
	}
}

interface SingleCall {
	method: string
	input: unknown
}

interface SingleResult {
	result?: unknown
	error?: { type: string; message: string; issues?: unknown }
}

function resolve(router: AnyRouter, methodPath: string): AnyProcedure | null {
	const parts = methodPath.split('.')
	let node: AnyProcedure | AnyRouter = router
	for (const part of parts) {
		if (node._tag !== 'router') return null
		const def: RouterDef = node._def
		const next = def[part]
		if (!next) return null
		node = next
	}
	return node._tag === 'procedure' ? node : null
}

async function invokeProcedure(procedure: AnyProcedure, ctx: unknown, rawInput: unknown): Promise<unknown> {
	// Normalize JSON's `null` to `undefined` for procedures with `z.void()` input.
	const normalized = rawInput === null ? undefined : rawInput
	let parsedInput: unknown
	try {
		parsedInput = procedure.input.parse(normalized)
	} catch (err) {
		throw new RpcDispatchError({
			type: 'validation',
			message: err instanceof Error ? err.message : 'validation failed',
			httpStatus: 400,
			issues: extractZodIssues(err),
		})
	}
	const output = await procedure.handler({ ctx, input: parsedInput })
	try {
		return procedure.output.parse(output)
	} catch (err) {
		throw new RpcDispatchError({
			type: 'internal',
			message: `Output validation failed: ${err instanceof Error ? err.message : String(err)}`,
			httpStatus: 500,
		})
	}
}

function extractZodIssues(err: unknown): unknown {
	if (err && typeof err === 'object' && 'issues' in err) {
		return (err as { issues: unknown }).issues
	}
	return undefined
}

async function dispatchOne(router: AnyRouter, ctx: unknown, call: SingleCall): Promise<SingleResult> {
	const procedure = resolve(router, call.method)
	if (!procedure) {
		return { error: { type: 'method_not_found', message: `Unknown method: ${call.method}` } }
	}
	try {
		const result = await invokeProcedure(procedure, ctx, call.input)
		return { result }
	} catch (err) {
		if (err instanceof RpcDispatchError) {
			return { error: { type: err.type, message: err.message, ...(err.issues ? { issues: err.issues } : {}) } }
		}
		const message = err instanceof Error ? err.message : String(err)
		return { error: { type: 'internal', message } }
	}
}

export async function dispatchRpcRequest<TContext>(args: {
	router: AnyRouter
	buildContext: (request: Request) => Promise<TContext> | TContext
	request: Request
}): Promise<Response> {
	let rawBody: unknown
	try {
		rawBody = await args.request.json()
	} catch {
		return jsonResponse({ error: { type: 'validation', message: 'Invalid JSON body' } }, 400)
	}

	const ctx = await args.buildContext(args.request)

	if (rawBody && typeof rawBody === 'object' && 'batch' in rawBody && Array.isArray((rawBody as { batch: unknown }).batch)) {
		const batch = (rawBody as { batch: SingleCall[] }).batch
		const results: SingleResult[] = []
		for (const call of batch) {
			results.push(await dispatchOne(args.router, ctx, call))
		}
		return jsonResponse({ batch: results }, 200)
	}

	if (!rawBody || typeof rawBody !== 'object' || typeof (rawBody as SingleCall).method !== 'string') {
		return jsonResponse({ error: { type: 'validation', message: 'Body must be { method, input } or { batch: [...] }' } }, 400)
	}

	const single = await dispatchOne(args.router, ctx, rawBody as SingleCall)
	if (single.error) {
		return jsonResponse(single, deriveHttpStatus(single.error.type))
	}
	return jsonResponse(single, 200)
}

function deriveHttpStatus(type: string): number {
	switch (type) {
		case 'validation': return 400
		case 'auth': return 401
		case 'forbidden': return 403
		case 'not_found':
		case 'method_not_found': return 404
		case 'conflict': return 409
		default: return 500
	}
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}
