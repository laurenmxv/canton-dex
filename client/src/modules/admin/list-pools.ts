import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolDetail } from '../../types/pool.js';

/** Every pool the venue currently runs, with the contracts behind it. */
export async function listPoolDetails(
  send: Send,
  options?: RequestOptions,
): Promise<PoolDetail[]> {
  return send<PoolDetail[]>({ method: 'GET', path: '/v1/admin/pools' }, options);
}
