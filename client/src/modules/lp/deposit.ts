import { segment, type Send } from '../../core/http.js';
import type { RequestOptions } from '../../types/common.js';
import type {
  DepositPreparation,
  DepositQuote,
  DepositQuoteInput,
  DepositRequest,
  PrepareDepositInput,
} from '../../types/liquidity.js';
import type { SubmitSignatureInput } from '../../types/swap.js';

export async function quoteDeposit(
  send: Send,
  input: DepositQuoteInput,
  options?: RequestOptions,
): Promise<DepositQuote> {
  return send<DepositQuote>({ method: 'POST', path: '/v1/lp/deposit/quote', body: input }, options);
}

/** The same quote on the same terms answers with the preparation that already exists. */
export async function prepareDeposit(
  send: Send,
  input: PrepareDepositInput,
  options?: RequestOptions,
): Promise<DepositPreparation> {
  return send<DepositPreparation>(
    { method: 'POST', path: '/v1/lp/deposit/prepare', body: input },
    options,
  );
}

/** Sent once: a lost reply leaves the outcome unknown, so read the request back instead. */
export async function submitDeposit(
  send: Send,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<DepositRequest> {
  return send<DepositRequest>(
    { method: 'POST', path: '/v1/lp/deposit/submit', body: input },
    options,
  );
}

export async function getDeposit(
  send: Send,
  depositId: string,
  options?: RequestOptions,
): Promise<DepositRequest> {
  return send<DepositRequest>(
    { method: 'GET', path: `/v1/lp/deposit/${segment(depositId)}` },
    options,
  );
}

export async function prepareDepositCancellation(
  send: Send,
  depositId: string,
  options?: RequestOptions,
): Promise<DepositPreparation> {
  return send<DepositPreparation>(
    { method: 'POST', path: `/v1/lp/deposit/${segment(depositId)}/cancel/prepare` },
    options,
  );
}

export async function submitDepositCancellation(
  send: Send,
  depositId: string,
  input: SubmitSignatureInput,
  options?: RequestOptions,
): Promise<DepositRequest> {
  return send<DepositRequest>(
    { method: 'POST', path: `/v1/lp/deposit/${segment(depositId)}/cancel/submit`, body: input },
    options,
  );
}
