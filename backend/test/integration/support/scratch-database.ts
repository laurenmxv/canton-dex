import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { initializeSchema } from '../../../src/bootstrap/schema.js';
import type { DatabaseConfig } from '../../../src/platform/config.js';
import { createDatabase, type Db } from '../../../src/platform/database.js';
import { independently } from '../../support/cleanup.js';

const IGNORE_IDLE_ERRORS = () => undefined;

/** An isolated database with the current schema; each store test gets its own. */
export interface ScratchDatabase {
  readonly db: Db;
  /** A new connection pool on the same data, as a restarted process would open. */
  reopen(): Db;
  initialize(): Promise<void>;
  drop(): Promise<void>;
}

function databaseConfig(url: string, database?: string): DatabaseConfig {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || '5432'),
    database: database ?? parsed.pathname.slice(1),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

export async function scratchDatabase(url: string): Promise<ScratchDatabase> {
  const name = `store_test_${randomUUID().replaceAll('-', '')}`;
  const admin = createDatabase(databaseConfig(url), IGNORE_IDLE_ERRORS);
  const config = databaseConfig(url, name);
  const pools: Db[] = [];
  const open = () => {
    const db = createDatabase(config, IGNORE_IDLE_ERRORS);
    pools.push(db);
    return db;
  };
  const drop = () =>
    independently(
      'Scratch database cleanup failed',
      ...pools.map((pool) => () => pool.destroy()),
      async () => {
        await sql.raw(`DROP DATABASE IF EXISTS ${name}`).execute(admin);
      },
      () => admin.destroy(),
    );
  try {
    await sql.raw(`CREATE DATABASE ${name}`).execute(admin);
    const db = open();
    await initializeSchema(db);
    return { db, reopen: open, initialize: () => initializeSchema(db), drop };
  } catch (error) {
    await drop().catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], 'Scratch database setup failed');
    });
    throw error;
  }
}
