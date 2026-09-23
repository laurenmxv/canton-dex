import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { SwapActivity, SwapActivityQuery } from '../../types/swap.js';

/**
 * The caller's own swap history, newest first.
 *
 * This is what recovers a session: every request the trader ever signed is here
 * after a reload, whatever the browser forgot. The route serves liquidity
 * requests too, under their own `type`, so this one is fixed to swaps.
 */
export async function listSwapActivity(
  send: Send,
  query: SwapActivityQuery = {},
  options?: RequestOptions,
): Promise<SwapActivity> {
  return send<SwapActivity>(
    {
      method: 'GET',
      path: '/v1/activity',
      query: {
        type: 'swap',
        status: query.status,
        limit: query.limit,
        cursor: query.cursor,
      },
    },
    options,
  );
}
