import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { LpPositions } from '../../types/liquidity.js';

/** Every pool the caller holds LP in, whatever their current access. */
export async function getPositions(send: Send, options?: RequestOptions): Promise<LpPositions> {
  return send<LpPositions>({ method: 'GET', path: '/v1/lp/positions' }, options);
}
