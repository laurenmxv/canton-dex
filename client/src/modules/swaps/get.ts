import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type { Swap } from '../../types/swap.js';

/** One of the caller's own requests. Another trader's answers 404. */
export async function getSwap(
  send: Send,
  swapId: string,
  options?: RequestOptions,
): Promise<Swap> {
  return send<Swap>({ method: 'GET', path: `/v1/swaps/${segment(swapId)}` }, options);
}
