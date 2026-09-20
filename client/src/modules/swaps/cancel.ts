import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { SubmitSignatureInput, Swap, SwapPreparation } from '../../types/swap.js';

/**
 * Prepares the withdrawal of whatever the request still holds.
 *
 * It is available only after the settlement deadline has elapsed. An unexpired
 * preparation is handed back rather than replaced, so a second attempt asks the
 * wallet to sign the same transaction.
 */
export async function prepareSwapCancellation(
  send: Send,
  swapId: string,
  options?: RequestOptions,
): Promise<SwapPreparation> {
  return send<SwapPreparation>(
    { method: 'POST', path: `/v1/swaps/${segment(swapId)}/cancel/prepare` },
    options,
  );
}

/**
 * Submits the signed withdrawal.
 *
 * The status in the answer is the authoritative one: the ledger can confirm
 * within the call, so `WITHDRAWN` is as possible as `WITHDRAWING`. Only
 * `WITHDRAWN` means the allocations are released.
 */
export async function submitSwapCancellation(
  send: Send,
  swapId: string,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<Swap> {
  return send<Swap>(
    { method: 'POST', path: `/v1/swaps/${segment(swapId)}/cancel/submit`, body: input },
    options,
  );
}
