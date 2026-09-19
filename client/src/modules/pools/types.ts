import type { RequestOptions } from '../../types/common.js';
import type { PoolDetail, PoolSummary } from '../../types/pool.js';

/** The venue's pool catalogue. */
export interface PoolsApi {
  list(options?: RequestOptions): Promise<PoolSummary[]>;
  get(poolId: string, options?: RequestOptions): Promise<PoolDetail>;
}
