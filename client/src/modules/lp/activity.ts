import type { Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type {
  DepositRequest,
  LiquidityActivity,
  LiquidityActivityQuery,
  LiquidityRequest,
  WithdrawalRequest,
} from '../../types/liquidity.js';

async function listActivity<Request extends LiquidityRequest>(
  send: Send,
  type: 'deposit' | 'withdraw',
  query: LiquidityActivityQuery,
  options: RequestOptions | undefined,
): Promise<LiquidityActivity<Request>> {
  return send<LiquidityActivity<Request>>(
    {
      method: 'GET',
      path: '/v1/activity',
      query: { type, status: query.status, limit: query.limit, cursor: query.cursor },
    },
    options,
  );
}

export function listDeposits(
  send: Send,
  query: LiquidityActivityQuery = {},
  options?: RequestOptions,
): Promise<LiquidityActivity<DepositRequest>> {
  return listActivity(send, 'deposit', query, options);
}

export function listWithdrawals(
  send: Send,
  query: LiquidityActivityQuery = {},
  options?: RequestOptions,
): Promise<LiquidityActivity<WithdrawalRequest>> {
  return listActivity(send, 'withdraw', query, options);
}
