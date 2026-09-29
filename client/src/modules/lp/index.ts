/**
 * Creates the liquidity API for deposits, withdrawals and positions.
 *
 * @remarks
 * createDexClient composes lp, swaps and tokens as separate trading APIs.
 * The swaps and tokens modules own their operations; all share the HTTP transport.
 *
 * @packageDocumentation
 */
import type { Send } from '../../core/http.js';
import { listDeposits, listWithdrawals } from './activity.js';
import {
  getDeposit,
  prepareDeposit,
  prepareDepositCancellation,
  quoteDeposit,
  submitDeposit,
  submitDepositCancellation,
} from './deposit.js';
import { getPositions } from './positions.js';
import type { LpApi } from './types.js';
import {
  getWithdrawal,
  prepareWithdrawal,
  prepareWithdrawalCancellation,
  quoteWithdrawal,
  submitWithdrawal,
  submitWithdrawalCancellation,
} from './withdrawal.js';

export function createLpApi(send: Send): LpApi {
  return {
    quoteDeposit: (input, options) => quoteDeposit(send, input, options),
    prepareDeposit: (input, options) => prepareDeposit(send, input, options),
    submitDeposit: (input, options) => submitDeposit(send, input, options),
    getDeposit: (depositId, options) => getDeposit(send, depositId, options),
    quoteWithdrawal: (input, options) => quoteWithdrawal(send, input, options),
    prepareWithdrawal: (input, options) => prepareWithdrawal(send, input, options),
    submitWithdrawal: (input, options) => submitWithdrawal(send, input, options),
    getWithdrawal: (withdrawalId, options) => getWithdrawal(send, withdrawalId, options),
    positions: (options) => getPositions(send, options),
    deposits: (query, options) => listDeposits(send, query, options),
    withdrawals: (query, options) => listWithdrawals(send, query, options),
    prepareDepositCancellation: (depositId, options) =>
      prepareDepositCancellation(send, depositId, options),
    submitDepositCancellation: (depositId, input, options) =>
      submitDepositCancellation(send, depositId, input, options),
    prepareWithdrawalCancellation: (withdrawalId, options) =>
      prepareWithdrawalCancellation(send, withdrawalId, options),
    submitWithdrawalCancellation: (withdrawalId, input, options) =>
      submitWithdrawalCancellation(send, withdrawalId, input, options),
  };
}

export type { LpApi } from './types.js';
