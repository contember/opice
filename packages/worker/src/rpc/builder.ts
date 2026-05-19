import type { Parseable, Procedure, Router, RouterDef } from './types'

class ProcedureBuilder<TContext, TInput, TOutput> {
	constructor(
		private readonly _input: Parseable<TInput> | null,
		private readonly _output: Parseable<TOutput> | null,
	) {}

	input<TNewInput>(schema: Parseable<TNewInput>): ProcedureBuilder<TContext, TNewInput, TOutput> {
		return new ProcedureBuilder<TContext, TNewInput, TOutput>(schema, this._output)
	}

	output<TNewOutput>(schema: Parseable<TNewOutput>): ProcedureBuilder<TContext, TInput, TNewOutput> {
		return new ProcedureBuilder<TContext, TInput, TNewOutput>(this._input, schema)
	}

	handler(fn: (args: { ctx: TContext; input: TInput }) => Promise<TOutput> | TOutput): Procedure<TContext, TInput, TOutput> {
		if (!this._input) throw new Error('Procedure missing input schema — call .input(...) before .handler(...)')
		if (!this._output) throw new Error('Procedure missing output schema — call .output(...) before .handler(...)')
		return {
			_tag: 'procedure',
			input: this._input,
			output: this._output,
			handler: fn,
		}
	}
}

export function initRpc<TContext>(): {
	procedure: ProcedureBuilder<TContext, void, unknown>
	router<TDef extends RouterDef>(def: TDef): Router<TDef>
} {
	const voidSchema: Parseable<void> = {
		parse(input: unknown): void {
			if (input !== undefined && input !== null) {
				throw new Error('Expected void input')
			}
		},
	}
	return {
		procedure: new ProcedureBuilder<TContext, void, unknown>(voidSchema, null),
		router<TDef extends RouterDef>(def: TDef): Router<TDef> {
			return { _tag: 'router', _def: def }
		},
	}
}
