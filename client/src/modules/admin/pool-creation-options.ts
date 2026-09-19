import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PoolCreationOptions } from '../../types/pool.js';

/** The venue configures these: a caller never names an authority or an owner. */
export async function poolCreationOptions(
  send: Send,
  options?: RequestOptions,
): Promise<PoolCreationOptions> {
  return send<PoolCreationOptions>(
    { method: 'GET', path: '/v1/admin/pool-proposals/options' },
    options,
  );
}
