import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolSummary } from '../../types/pool.js';

/**
 * Every pool the venue currently runs.
 *
 * This is the catalogue an operator approves from. It is not a statement about
 * what any trader may trade.
 */
export async function listPools(send: Send, options?: RequestOptions): Promise<PoolSummary[]> {
  return send<PoolSummary[]>({ method: 'GET', path: '/v1/pools' }, options);
}
