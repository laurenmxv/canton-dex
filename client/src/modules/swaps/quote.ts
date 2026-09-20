import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { SwapQuote, SwapQuoteInput } from '../../types/swap.js';

/**
 * Estimates an exact input against the pool's current confirmed reserves.
 *
 * Nothing is reserved and no ledger command is sent. `expectedOut` is what the
 * pool would pay at the reserves the venue has just seen, not a price it will
 * hold: a batch reprices every request against the reserves that hold when it
 * runs. Only the `minOut` the trader signs is binding. The expiry bounds how
 * long this quote can still be prepared from.
 */
export async function quoteSwap(
  send: Send,
  input: SwapQuoteInput,
  options?: RequestOptions,
): Promise<SwapQuote> {
  return send<SwapQuote>({ method: 'POST', path: '/v1/swaps/quote', body: input }, options);
}
