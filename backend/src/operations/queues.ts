import { sql, type Kysely } from 'kysely';
import type { Database, Family } from '../platform/database.js';

/** A connection or an open transaction. */
type Executor = Kysely<Database>;

/** A new family queue's batch size, capped by the configured maximum. */
const DEFAULT_BATCH_SIZE = 5;

export function initialBatchSize(maxBatchSize: number): number {
  return Math.min(DEFAULT_BATCH_SIZE, maxBatchSize);
}

/** Locks the pool's queue row, which serializes admission, policy changes and settlement. */
export async function lockPoolQueue(trx: Executor, poolId: string): Promise<void> {
  const row = await trx
    .selectFrom('pool_queues')
    .select('pool_id')
    .where('pool_id', '=', poolId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new Error(`Pool ${poolId} has no settlement queue`);
}

/**
 * Request admission takes the pool queue lock before the request row, the order settlement uses,
 * and creates the family queue on first use.
 */
export async function lockForAdmission(
  trx: Executor,
  poolId: string,
  family: Family,
  maxBatchSize: number,
): Promise<void> {
  await sql`INSERT INTO pool_queues(pool_id) VALUES(${poolId}) ON CONFLICT DO NOTHING`.execute(trx);
  await lockPoolQueue(trx, poolId);
  await trx
    .insertInto('pool_request_queues')
    .values({ pool_id: poolId, family, batch_size: initialBatchSize(maxBatchSize) })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

/** The family's next arrival sequence. */
export async function nextArrival(trx: Executor, poolId: string, family: Family): Promise<bigint> {
  const row = await trx
    .updateTable('pool_request_queues')
    .set((eb) => ({ next_sequence: eb('next_sequence', '+', 1n) }))
    .where('pool_id', '=', poolId)
    .where('family', '=', family)
    .returning('next_sequence')
    .executeTakeFirstOrThrow();
  return row.next_sequence;
}

/** A request left its family's head, so a blocked family may be selected again. */
export async function unblockFamily(trx: Executor, poolId: string, family: Family): Promise<void> {
  await trx
    .updateTable('pool_request_queues')
    .set({ blocked_version: null })
    .where('pool_id', '=', poolId)
    .where('family', '=', family)
    .execute();
}
