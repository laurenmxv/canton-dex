import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolDetail } from '../../types/pool.js';

/** One pool, for any authenticated caller rather than operators alone. */
export async function getPool(
  send: Send,
  poolId: string,
  options?: RequestOptions,
): Promise<PoolDetail> {
  return send<PoolDetail>({ method: 'GET', path: `/v1/pools/${segment(poolId)}` }, options);
}
