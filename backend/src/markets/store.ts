import type { Db } from '../platform/database.js';
import { instantText, isoInstant } from '../platform/time.js';
import { readSwap } from '../swaps/store.js';
import type { TradeEvidence } from './model.js';

/**
 * Reads market history from the durable settlement records already needed for
 * recovery. There is no projection to replay or duplicate after a restart.
 */
export class MarketStore {
  constructor(private readonly db: Db) {}

  async confirmedTrades(poolId: string, since: bigint, through: bigint): Promise<TradeEvidence[]> {
    const rows = await this.db
      .selectFrom('swap_requests as swap')
      .innerJoin('settlement_batches as batch', 'batch.id', 'swap.settlement_id')
      .selectAll('swap')
      .select('batch.updated_at as settled_at')
      .where('batch.pool_id', '=', poolId)
      .where('batch.status', '=', 'CONFIRMED')
      .where('swap.status', '=', 'SETTLED')
      .where('batch.updated_at', '>=', instantText(since))
      .where('batch.updated_at', '<=', instantText(through))
      .orderBy('batch.updated_at', 'asc')
      .orderBy('swap.id', 'asc')
      .execute();

    return rows.map((row) => {
      const swap = readSwap(row);
      if (swap.amountOut === null) throw new Error(`Settled swap ${swap.swapId} has no amount out`);
      return {
        swapId: swap.swapId,
        direction: swap.direction,
        amountIn: swap.amountIn,
        amountOut: swap.amountOut,
        settledAt: isoInstant(row.settled_at),
      };
    });
  }
}
