import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type {
  PrepareWithdrawalInput,
  WithdrawalPreparation,
  WithdrawalQuote,
  WithdrawalQuoteInput,
  WithdrawalRequest,
} from '../../types/liquidity.js';
import type { SubmitSignatureInput } from '../../types/swap.js';

export async function quoteWithdrawal(
  send: Send,
  input: WithdrawalQuoteInput,
  options?: RequestOptions,
): Promise<WithdrawalQuote> {
  return send<WithdrawalQuote>(
    { method: 'POST', path: '/v1/lp/withdraw/quote', body: input },
    options,
  );
}

export async function prepareWithdrawal(
  send: Send,
  input: PrepareWithdrawalInput,
  options?: RequestOptions,
): Promise<WithdrawalPreparation> {
  return send<WithdrawalPreparation>(
    { method: 'POST', path: '/v1/lp/withdraw/prepare', body: input },
    options,
  );
}

/** Sent once: a lost reply leaves the outcome unknown, so read the request back instead. */
export async function submitWithdrawal(
  send: Send,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<WithdrawalRequest> {
  return send<WithdrawalRequest>(
    { method: 'POST', path: '/v1/lp/withdraw/submit', body: input },
    options,
  );
}

export async function getWithdrawal(
  send: Send,
  withdrawalId: string,
  options?: RequestOptions,
): Promise<WithdrawalRequest> {
  return send<WithdrawalRequest>(
    { method: 'GET', path: `/v1/lp/withdraw/${segment(withdrawalId)}` },
    options,
  );
}

export async function prepareWithdrawalCancellation(
  send: Send,
  withdrawalId: string,
  options?: RequestOptions,
): Promise<WithdrawalPreparation> {
  return send<WithdrawalPreparation>(
    { method: 'POST', path: `/v1/lp/withdraw/${segment(withdrawalId)}/cancel/prepare` },
    options,
  );
}

export async function submitWithdrawalCancellation(
  send: Send,
  withdrawalId: string,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<WithdrawalRequest> {
  return send<WithdrawalRequest>(
    {
      method: 'POST',
      path: `/v1/lp/withdraw/${segment(withdrawalId)}/cancel/submit`,
      body: input,
    },
    options,
  );
}
