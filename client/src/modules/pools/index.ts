import type { Send } from '../../core/http.js';
import { getPool } from './get.js';
import { listPools } from './list.js';
import type { PoolsApi } from './types.js';

export function createPoolsApi(send: Send): PoolsApi {
  return {
    list: (options) => listPools(send, options),
    get: (poolId, options) => getPool(send, poolId, options),
  };
}

export type { PoolsApi } from './types.js';
