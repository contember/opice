/**
 * Generate a D1 migration for the BetterAuth schema.
 *
 *   bun run scripts/generate-betterauth-migration.ts <name>
 *
 * Loads the existing `migrations/auth/*.sql` into an in-memory bun:sqlite DB,
 * asks BetterAuth to diff its required schema against that DB, and writes any
 * missing statements to `migrations/auth/{NNNN+1}_{name}.sql`. Run it whenever
 * the auth config in `src/identity/better-auth.ts` changes (new plugin, field).
 *
 * Ported from contember/webmaster + chutoo's equivalent.
 */
import { getMigrations } from 'better-auth/db/migration'
import { Glob } from 'bun'
import { Database } from 'bun:sqlite'
import { buildAuthOptions } from '../src/identity/better-auth'
import { BunSqliteDialect } from './bun-sqlite-dialect'

const migrationName = process.argv[2]

if (!migrationName) {
	console.error('Please provide a migration name as the first argument.')
	process.exit(1)
}

if (!migrationName.match(/^[a-z0-9-]+$/)) {
	console.error('Migration name can only contain lowercase letters, numbers and dashes.')
	process.exit(1)
}

const migrationsDir = new URL('../migrations/auth/', import.meta.url)
const files = Array.from(new Glob('*.sql').scanSync(migrationsDir.pathname))
files.sort()

const database = new Database(':memory:')
for (const file of files) {
	const absolutePath = new URL(file, migrationsDir).pathname
	const sql = await Bun.file(absolutePath).text()
	database.exec(sql)
}

const options = buildAuthOptions({
	config: { secret: 'a'.repeat(32) },
	database: { dialect: new BunSqliteDialect({ database }), type: 'sqlite' },
})

const migrations = await getMigrations(options)
const migrationContent = await migrations.compileMigrations()

if (!migrationContent.trim() || migrationContent.trim() === ';') {
	console.log('No new migrations to create.')
	process.exit(0)
}

const latestMigrationNumber = files.at(-1)?.split('_')[0] ?? '0000'
const newMigrationNumber = (Number(latestMigrationNumber) + 1).toString().padStart(4, '0')
const migrFileName = `${newMigrationNumber}_${migrationName}.sql`
await Bun.write(`${migrationsDir.pathname}/${migrFileName}`, migrationContent)

console.log(`Created migration ${migrFileName}`)
