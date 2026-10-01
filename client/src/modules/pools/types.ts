import type { RequestOptions } from '../../types/common.js';
import type { MarketData, MarketDataQuery, PoolDetail, PoolSummary } from '../../types/pool.js';

/** The venue's pool catalogue. */
export interface PoolsApi {
  list(options?: RequestOptions): Promise<PoolSummary[]>;
  get(poolId: string, options?: RequestOptions): Promise<PoolDetail>;
  marketData(
    poolId: string,
    query?: MarketDataQuery,
    options?: RequestOptions,
  ): Promise<MarketData>;
}
