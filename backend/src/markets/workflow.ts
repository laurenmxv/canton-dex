import { clockNanos, NANOS_PER_SECOND } from '../platform/time.js';
import type { PoolWorkflow } from '../pools/workflow.js';
import { marketData, type MarketData } from './model.js';
import type { MarketStore } from './store.js';

const DAY_NANOS = 86_400n * NANOS_PER_SECOND;

export interface MarketDataQuery {
  readonly candleLimit: number;
  readonly recentLimit: number;
}

/** Combines current ledger reserves with confirmed, durable settlement history. */
export class MarketWorkflow {
  constructor(
    private readonly store: MarketStore,
    private readonly pools: PoolWorkflow,
    private readonly clock: () => bigint = clockNanos,
  ) {}

  async get(poolId: string, query: MarketDataQuery): Promise<MarketData> {
    const asOf = this.clock();
    const [pool, trades] = await Promise.all([
      this.pools.pool(poolId),
      this.store.confirmedTrades(poolId, asOf - DAY_NANOS, asOf),
    ]);
    return marketData(pool, trades, asOf, query.candleLimit, query.recentLimit);
  }
}
