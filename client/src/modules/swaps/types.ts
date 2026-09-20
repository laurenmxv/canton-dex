import type { RequestOptions } from '../../types/common.js';
import type {
  PrepareSwapInput,
  SubmitSignatureInput,
  Swap,
  SwapActivity,
  SwapActivityQuery,
  SwapPreparation,
  SwapQuote,
  SwapQuoteInput,
} from '../../types/swap.js';

/**
 * One trader's swaps, from a price to a settled or reclaimed request.
 *
 * Quoting, preparing and submitting are three separate calls because they are
 * three separate commitments: only the third one asks the ledger for anything,
 * and only a signature the wallet produced can make it.
 */
export interface SwapsApi {
  quote(input: SwapQuoteInput, options?: RequestOptions): Promise<SwapQuote>;
  prepare(input: PrepareSwapInput, options?: RequestOptions): Promise<SwapPreparation>;
  submit(input: SubmitSignatureInput, options?: RequestOptions): Promise<Swap>;
  get(swapId: string, options?: RequestOptions): Promise<Swap>;
  prepareCancellation(swapId: string, options?: RequestOptions): Promise<SwapPreparation>;
  submitCancellation(
    swapId: string,
    input: SubmitSignatureInput,
    options?: RequestOptions,
  ): Promise<Swap>;
  activity(query?: SwapActivityQuery, options?: RequestOptions): Promise<SwapActivity>;
}
