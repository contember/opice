import type { Database } from 'bun:sqlite'
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

export interface BunSqliteDialectConfig {
	database: Database
}

/**
 * Kysely dialect for `bun:sqlite`. Only used off the request path — by
 * `scripts/generate-betterauth-migration.ts`, which diffs the BetterAuth
 * schema against an in-memory DB to emit migration SQL. Mirrors `D1Dialect`
 * so the factory is portable between the two.
 */
export class BunSqliteDialect implements Dialect {
	#config: BunSqliteDialectConfig

	constructor(config: BunSqliteDialectConfig) {
		this.#config = config
	}

	createAdapter() {
		return new SqliteAdapter()
	}

	createDriver(): Driver {
		return new BunSqliteDriver(this.#config)
	}

	createQueryCompiler(): QueryCompiler {
		return new SqliteQueryCompiler()
	}

	createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
		return new SqliteIntrospector(db)
	}
}

const READ_QUERY_PREFIX = /^\s*(select|pragma|with|explain)\b/i
const RETURNING_CLAUSE = /\breturning\b/i

class BunSqliteDriver implements Driver {
	#config: BunSqliteDialectConfig

	constructor(config: BunSqliteDialectConfig) {
		this.#config = config
	}

	async init(): Promise<void> {}

	async acquireConnection(): Promise<DatabaseConnection> {
		return new BunSqliteConnection(this.#config.database)
	}

	async beginTransaction(conn: BunSqliteConnection): Promise<void> {
		await conn.executeQuery(CompiledQuery.raw('BEGIN'))
	}

	async commitTransaction(conn: BunSqliteConnection): Promise<void> {
		await conn.executeQuery(CompiledQuery.raw('COMMIT'))
	}

	async rollbackTransaction(conn: BunSqliteConnection): Promise<void> {
		await conn.executeQuery(CompiledQuery.raw('ROLLBACK'))
	}

	async releaseConnection(_conn: BunSqliteConnection): Promise<void> {}

	async destroy(): Promise<void> {}
}

class BunSqliteConnection implements DatabaseConnection {
	#db: Database

	constructor(db: Database) {
		this.#db = db
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const params = compiledQuery.parameters as (string | number | bigint | boolean | Uint8Array | null)[]
		const stmt = this.#db.prepare(compiledQuery.sql)
		if (READ_QUERY_PREFIX.test(compiledQuery.sql)) {
			const rows = stmt.all(...params) as O[]
			return { insertId: undefined, rows, numAffectedRows: undefined }
		}
		if (RETURNING_CLAUSE.test(compiledQuery.sql)) {
			const rows = stmt.all(...params) as O[]
			return { insertId: undefined, rows, numAffectedRows: rows.length > 0 ? BigInt(rows.length) : undefined }
		}
		const result = stmt.run(...params)
		return {
			insertId: result.lastInsertRowid === undefined || result.lastInsertRowid === null
				? undefined
				: BigInt(result.lastInsertRowid),
			rows: [],
			numAffectedRows: result.changes > 0 ? BigInt(result.changes) : undefined,
		}
	}

	// oxlint-disable-next-line require-yield — Kysely interface requires a generator
	async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
		throw new Error('BunSqlite driver does not support streaming')
	}
}
