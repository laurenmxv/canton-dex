import type { Account } from '../iam/accounts.js';
import type { Before } from '../swaps/model.js';
import type {
  Activity,
  Confirmation,
  DepositQuote,
  DepositQuoteInput,
  Kind,
  Pending,
  Positions,
  Request,
  SigningPayload,
  Terms,
  WithdrawalQuote,
  WithdrawalQuoteInput,
} from './model.js';

/** Canton definitely rejected a liquidity submission without committing it. */
export class LiquidityRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LiquidityLedger {
  offset(): Promise<bigint>;
  requireAccess(caller: Account, poolId: string): Promise<void>;
  quoteDeposit(quoteId: string, caller: Account, accessToken: string, input: DepositQuoteInput): Promise<DepositQuote>;
  quoteWithdrawal(
    quoteId: string,
    caller: Account,
    accessToken: string,
    input: WithdrawalQuoteInput,
  ): Promise<WithdrawalQuote>;
  prepare(
    requestId: string,
    commandId: string,
    caller: Account,
    accessToken: string,
    terms: Terms,
  ): Promise<SigningPayload>;
  verify(signing: SigningPayload, signature: string, caller: Account): Promise<void>;
  submit(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation>;
  /** Evidence only: a missing transaction neither authorizes a replay nor proves a rejection. */
  recover(pending: Pending): Promise<Confirmation | undefined>;
  /** Settlement or direct allocation recovery, including while the backend was offline. */
  observe(confirmedSubmission: Pending): Promise<Confirmation | undefined>;
  prepareRecovery(commandId: string, request: Request, caller: Account, accessToken: string): Promise<SigningPayload>;
  executeRecovery(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation>;
  positions(caller: Account, accessToken: string): Promise<Positions>;
}

/** The durable liquidity requests and their preparations; `now` values are nanoseconds. */
export interface LiquidityProgress {
  saveDepositQuote(quote: DepositQuote, caller: Account): Promise<void>;
  saveWithdrawalQuote(quote: WithdrawalQuote, caller: Account): Promise<void>;
  depositQuote(id: string, caller: Account): Promise<DepositQuote>;
  withdrawalQuote(id: string, caller: Account): Promise<WithdrawalQuote>;
  preparedQuote(quoteId: string, caller: Account): Promise<Pending | undefined>;
  savePreparation(
    requestId: string,
    preparationId: string,
    commandId: string,
    quoteId: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending>;
  latestRecovery(requestId: string, caller: Account): Promise<Pending | undefined>;
  saveRecovery(
    requestId: string,
    preparationId: string,
    commandId: string,
    caller: Account,
    signing: SigningPayload,
    now: bigint,
  ): Promise<Pending>;
  begin(preparationId: string, caller: Account, signature: string, offset: bigint, now: bigint): Promise<boolean>;
  confirm(preparationId: string, confirmation: Confirmation): Promise<void>;
  uncertain(preparationId: string): Promise<void>;
  rejected(preparationId: string, failure: LiquidityRejected): Promise<void>;
  unresolved(): Promise<Pending[]>;
  tracked(): Promise<Pending[]>;
  pendingOwned(id: string, caller: Account): Promise<Pending>;
  owned(id: string, caller: Account): Promise<Request>;
  activity(caller: Account, kind: Kind, limit: number, cursor: string | null, status: string | null): Promise<Activity>;
}

/** The caller's history below a boundary, for the combined activity page. */
export interface LiquidityHistory {
  owned(id: string, caller: Account): Promise<Request>;
  activityBefore(
    caller: Account,
    kind: Kind | null,
    limit: number,
    before: Before | null,
    status: string | null,
  ): Promise<Activity>;
}
