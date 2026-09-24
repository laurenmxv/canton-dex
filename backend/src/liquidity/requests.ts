import { instant, notBlank, text, uuid, type JsonObject } from '../platform/request.js';
import { invalidBody, slippage } from '../swaps/requests.js';
import type { DepositQuoteInput, PrepareDepositInput, PrepareWithdrawalInput, WithdrawalQuoteInput } from './model.js';

/** POST /v1/lp/deposit/quote. */
export function depositQuoteInput(body: JsonObject): DepositQuoteInput {
  const poolId = text(body.poolId);
  const maxBaseAmount = text(body.maxBaseAmount);
  const maxQuoteAmount = text(body.maxQuoteAmount);
  const slippageBps = slippage(body.slippageBps);
  if (!notBlank(poolId) || !notBlank(maxBaseAmount) || !notBlank(maxQuoteAmount)) throw invalidBody();
  return { poolId, maxBaseAmount, maxQuoteAmount, slippageBps };
}

/** POST /v1/lp/withdraw/quote. */
export function withdrawalQuoteInput(body: JsonObject): WithdrawalQuoteInput {
  const poolId = text(body.poolId);
  const lpAmount = text(body.lpAmount);
  const slippageBps = slippage(body.slippageBps);
  if (!notBlank(poolId) || !notBlank(lpAmount)) throw invalidBody();
  return { poolId, lpAmount, slippageBps };
}

/** POST /v1/lp/deposit/prepare. */
export function prepareDepositInput(body: JsonObject): PrepareDepositInput {
  const quoteId = uuid(body.quoteId);
  const minLpOut = text(body.minLpOut);
  const minRatio = text(body.minRatio);
  const maxRatio = text(body.maxRatio);
  const settlementDeadline = instant(body.settlementDeadline);
  if (quoteId === null || !notBlank(minLpOut) || !notBlank(minRatio) || !notBlank(maxRatio)) throw invalidBody();
  if (settlementDeadline === null) throw invalidBody();
  return { quoteId, minLpOut, minRatio, maxRatio, settlementDeadline };
}

/** POST /v1/lp/withdraw/prepare. */
export function prepareWithdrawalInput(body: JsonObject): PrepareWithdrawalInput {
  const quoteId = uuid(body.quoteId);
  const minBaseOut = text(body.minBaseOut);
  const minQuoteOut = text(body.minQuoteOut);
  const settlementDeadline = instant(body.settlementDeadline);
  if (quoteId === null || !notBlank(minBaseOut) || !notBlank(minQuoteOut) || settlementDeadline === null) {
    throw invalidBody();
  }
  return { quoteId, minBaseOut, minQuoteOut, settlementDeadline };
}
