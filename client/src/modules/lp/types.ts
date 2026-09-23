import type { RequestOptions } from '../../types/common.js';
import type {
  DepositPreparation,
  DepositQuote,
  DepositQuoteInput,
  DepositRequest,
  LiquidityActivity,
  LiquidityActivityQuery,
  LpPositions,
  PrepareDepositInput,
  PrepareWithdrawalInput,
  WithdrawalPreparation,
  WithdrawalQuote,
  WithdrawalQuoteInput,
  WithdrawalRequest,
} from '../../types/liquidity.js';
import type { SubmitSignatureInput } from '../../types/swap.js';

/** Deposits, withdrawals, and recovery of either once its deadline has passed. */
export interface LpApi {
  quoteDeposit(input: DepositQuoteInput, options?: RequestOptions): Promise<DepositQuote>;
  prepareDeposit(input: PrepareDepositInput, options?: RequestOptions): Promise<DepositPreparation>;
  submitDeposit(input: SubmitSignatureInput, options?: RequestOptions): Promise<DepositRequest>;
  getDeposit(depositId: string, options?: RequestOptions): Promise<DepositRequest>;
  quoteWithdrawal(input: WithdrawalQuoteInput, options?: RequestOptions): Promise<WithdrawalQuote>;
  prepareWithdrawal(
    input: PrepareWithdrawalInput,
    options?: RequestOptions,
  ): Promise<WithdrawalPreparation>;
  submitWithdrawal(input: SubmitSignatureInput, options?: RequestOptions): Promise<WithdrawalRequest>;
  getWithdrawal(withdrawalId: string, options?: RequestOptions): Promise<WithdrawalRequest>;
  positions(options?: RequestOptions): Promise<LpPositions>;
  deposits(
    query?: LiquidityActivityQuery,
    options?: RequestOptions,
  ): Promise<LiquidityActivity<DepositRequest>>;
  withdrawals(
    query?: LiquidityActivityQuery,
    options?: RequestOptions,
  ): Promise<LiquidityActivity<WithdrawalRequest>>;
  prepareDepositCancellation(
    depositId: string,
    options?: RequestOptions,
  ): Promise<DepositPreparation>;
  submitDepositCancellation(
    depositId: string,
    input: SubmitSignatureInput,
    options?: RequestOptions,
  ): Promise<DepositRequest>;
  prepareWithdrawalCancellation(
    withdrawalId: string,
    options?: RequestOptions,
  ): Promise<WithdrawalPreparation>;
  submitWithdrawalCancellation(
    withdrawalId: string,
    input: SubmitSignatureInput,
    options?: RequestOptions,
  ): Promise<WithdrawalRequest>;
}
