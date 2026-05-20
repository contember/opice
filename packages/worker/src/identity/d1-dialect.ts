import {
	CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type Driver,
	Kysely,
	type QueryCompiler,
	type QueryResult,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from 'kysely'

export interface D1DialectConfig {
	database: D1Database
}

/**
 * Kysely dialect for Cloudflare D1 — the storage layer BetterAuth talks to.
 *
 * ```ts
 * new D1Dialect({ database: env.AUTH_DB })
 * ```
 *
 * D1 has no interactive transactions, so begin/commit/rollback throw. BetterAuth
 * never opens an explicit transaction for the email+password flows we use.
 */
export class D1Dialect implements Dialect {
	#config: D1DialectConfig

	constructor(config: D1DialectConfig) {
		this.#config = config
	}

	createAdapter() {
		return new SqliteAdapter()
	}

	createDriver(): Driver {
		return new D1Driver(this.#config)
	}

	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler()
	}

	createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
		return new SqliteIntrospector(db)
	}
}

class D1Driver implements Driver {
	#config: D1DialectConfig

	constructor(config: D1DialectConfig) {
		this.#config = config
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return new D1Connection(this.#config)
	}

	async beginTransaction(conn: D1Connection): Promise<void> {
		return await conn.beginTransaction()
	}

	async commitTransaction(conn: D1Connection): Promise<void> {
		return await conn.commitTransaction()
	}

	async rollbackTransaction(conn: D1Connection): Promise<void> {
		return await conn.rollbackTransaction()
	}

	async releaseConnection(_conn: D1Connection): Promise<void> {}

	async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
	#config: D1DialectConfig

	constructor(config: D1DialectConfig) {
		this.#config = config
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const results = await this.#config.database
			.prepare(compiledQuery.sql)
			.bind(...compiledQuery.parameters)
			.all()
		if (results.error) {
			throw new Error(results.error)
		}

		const numAffectedRows = results.meta.changes > 0 ? BigInt(results.meta.changes) : undefined

		return {
			insertId: results.meta.last_row_id === undefined || results.meta.last_row_id === null
				? undefined
				: BigInt(results.meta.last_row_id),
			rows: (results?.results as O[]) || [],
			numAffectedRows,
		}
	}

	async beginTransaction() {
		throw new Error('D1 transactions are not supported.')
	}

	async commitTransaction() {
		throw new Error('D1 transactions are not supported.')
	}

	async rollbackTransaction() {
		throw new Error('D1 transactions are not supported.')
	}

	// oxlint-disable-next-line require-yield — Kysely interface requires a generator
	async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
		throw new Error('D1 driver does not support streaming')
	}
}
