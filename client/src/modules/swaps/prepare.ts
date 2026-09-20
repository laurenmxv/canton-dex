import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { PrepareSwapInput, SwapPreparation } from '../../types/swap.js';

/**
 * Turns an unexpired quote into a transaction the trader's wallet can sign.
 *
 * Preparing the same quote twice with the same terms answers with the same
 * preparation rather than building a second one; preparing it with different
 * terms is refused.
 */
export async function prepareSwap(
  send: Send,
  input: PrepareSwapInput,
  options?: RequestOptions,
): Promise<SwapPreparation> {
  return send<SwapPreparation>({ method: 'POST', path: '/v1/swaps/prepare', body: input }, options);
}
