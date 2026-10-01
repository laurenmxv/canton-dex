import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { MarketData, MarketDataQuery } from '../../types/pool.js';

export function getMarketData(
  send: Send,
  poolId: string,
  query?: MarketDataQuery,
  options?: RequestOptions,
): Promise<MarketData> {
  return send<MarketData>(
    {
      method: 'GET',
      path: `/v1/pools/${segment(poolId)}/market-data`,
      query: query
        ? {
            interval: query.interval,
            candleLimit: query.candleLimit,
            recentLimit: query.recentLimit,
          }
        : undefined,
    },
    options,
  );
}
