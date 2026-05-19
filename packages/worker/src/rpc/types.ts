/**
 * Minimal tRPC-like RPC engine — port of the chutoo lib/src/rpc pattern,
 * trimmed for opice's single-tenant v1.
 *
 * Single POST endpoint receives { method: "scope.procedure", input } and
 * returns { result } or { error }. Type-safety is exported as an `AppRouter`
 * type the dashboard consumes via `InferRouterClient<AppRouter>`.
 */

export interface Parseable<T> {
	parse(input: unknown): T
}

export interface Procedure<TContext, TInput, TOutput> {
	readonly _tag: 'procedure'
	readonly input: Parseable<TInput>
	readonly output: Parseable<TOutput>
	handler(args: { ctx: TContext; input: TInput }): Promise<TOutput> | TOutput
}

export interface AnyProcedure {
	readonly _tag: 'procedure'
	readonly input: Parseable<unknown>
	readonly output: Parseable<unknown>
	handler(args: { ctx: unknown; input: unknown }): Promise<unknown> | unknown
}

export type RouterDef = {
	readonly [key: string]: AnyProcedure | AnyRouter
}

export interface Router<TDef extends RouterDef> {
	readonly _tag: 'router'
	readonly _def: TDef
}

export type AnyRouter = Router<RouterDef>

export type InferRouterClient<TRouter> = TRouter extends { _tag: 'router'; _def: infer TDef }
	? TDef extends RouterDef
		? {
				[K in keyof TDef]: TDef[K] extends Procedure<unknown, infer I, infer O>
					? (input: I) => Promise<O>
					: TDef[K] extends Router<RouterDef>
						? InferRouterClient<TDef[K]>
						: never
			}
		: never
	: never
