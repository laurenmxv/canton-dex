import type { DepositRequest, LiquidityStatus, WithdrawalRequest } from './liquidity.js';
import type { Swap, SwapStatus } from './swap.js';

export type RequestType = 'swap' | 'deposit' | 'withdraw';

/** Any of the caller's requests, tagged with its kind. */
export type TaggedRequest =
  | { type: 'swap'; request: Swap }
  | { type: 'deposit'; request: DepositRequest }
  | { type: 'withdraw'; request: WithdrawalRequest };

/** One page of every kind of request, newest first. */
export interface Activity {
  items: readonly TaggedRequest[];
  /** Null on the last page. Pass it back as `cursor` for the next one. */
  nextCursor: string | null;
}

export interface ActivityQuery {
  status?: SwapStatus | LiquidityStatus;
  /** Between 1 and 100. */
  limit?: number;
  cursor?: string;
}
