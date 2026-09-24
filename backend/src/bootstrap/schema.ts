import { sql, type Kysely } from 'kysely';
import { DEX_PACKAGE_ID } from '../canton/packages.js';
import { RESET_INSTRUCTION, schemaStatements, type Database } from '../platform/database.js';

/** A scratch schema, created and dropped inside the initialization transaction. */
const REFERENCE_SCHEMA = 'dex_schema_reference';

/** Columns, constraints and indexes of one schema, without schema-qualified names. */
async function catalog(trx: Kysely<Database>, schema: string): Promise<string[]> {
  await sql`SELECT set_config('search_path', ${schema}, true)`.execute(trx);
  const { rows } = await sql<{ entry: string }>`
    SELECT format('%s.%s %s %s %s', table_name, column_name, data_type, is_nullable, coalesce(column_default, '')) AS entry
      FROM information_schema.columns WHERE table_schema = ${schema}
    UNION ALL
    SELECT format('%s %s', t.relname, pg_get_constraintdef(c.oid))
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${schema}
    UNION ALL
    SELECT format('%s %s', tablename, regexp_replace(indexdef, 'INDEX \\S+ ON \\S+\\.', 'INDEX ON '))
      FROM pg_indexes WHERE schemaname = ${schema}
    ORDER BY 1`.execute(trx);
  return rows.map((row) => row.entry);
}

/**
 * Applies `db/schema.sql` in one transaction. Existing data is kept; a schema that differs from
 * the file in any column, constraint or index is rejected instead of being migrated.
 */
export async function initializeSchema(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const application = (await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(trx)).rows[0]?.schema;
    if (!application) throw new Error('The database session has no current schema');
    await sql.raw(schemaStatements()).execute(trx);
    await sql.raw(`CREATE SCHEMA ${REFERENCE_SCHEMA}`).execute(trx);
    await sql`SELECT set_config('search_path', ${REFERENCE_SCHEMA}, true)`.execute(trx);
    await sql.raw(schemaStatements()).execute(trx);
    const expected = await catalog(trx, REFERENCE_SCHEMA);
    const actual = await catalog(trx, application);
    await sql.raw(`DROP SCHEMA ${REFERENCE_SCHEMA} CASCADE`).execute(trx);
    await sql`SELECT set_config('search_path', ${application}, true)`.execute(trx);
    const unexpected = actual.filter((entry) => !expected.includes(entry));
    const missing = expected.filter((entry) => !actual.includes(entry));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(
        `The application database has an incompatible schema (${[...missing, ...unexpected].slice(0, 3).join('; ')}). ${RESET_INSTRUCTION}.`,
      );
    }
  });
}

/** Pools of an older contract generation cannot be served by this package. */
export async function requireCurrentGeneration(db: Kysely<Database>): Promise<void> {
  const { count } = await db
    .selectFrom('pools')
    .select((row) => row.fn.countAll<bigint>().as('count'))
    .where('package_id', '<>', DEX_PACKAGE_ID)
    .executeTakeFirstOrThrow();
  if (count !== 0n) {
    throw new Error(
      `This contract generation needs fresh local participant and application databases. ${RESET_INSTRUCTION}.`,
    );
  }
}
