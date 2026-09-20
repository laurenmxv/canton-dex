import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { SubmitSignatureInput, Swap } from '../../types/swap.js';

/**
 * Hands the trader's signature to the venue, which submits the prepared
 * transaction unchanged.
 *
 * The answer is the request as it stands the moment the venue replies, and
 * that status is the authoritative one: the ledger can confirm within the call,
 * so `READY` is as possible as `SUBMITTING`. A reply that never arrives leaves
 * the outcome unknown rather than failed, so nothing here is retried; read the
 * request back instead.
 */
export async function submitSwap(
  send: Send,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<Swap> {
  return send<Swap>({ method: 'POST', path: '/v1/swaps/submit', body: input }, options);
}
