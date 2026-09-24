import type { Account } from '../iam/accounts.js';
import type {
  Activity,
  Before,
  Confirmation,
  Pending,
  Quote,
  QuoteInput,
  SigningPayload,
  Swap,
  Terms,
} from './model.js';

/** Canton definitely rejected a submission without committing it. Only use it with that proof. */
export class SwapRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SwapLedger {
  offset(): Promise<bigint>;
  requireAccess(caller: Account, poolId: string): Promise<void>;
  /** Validates ownership, pool eligibility and backing, with exact decimal quote arithmetic. */
  quote(quoteId: string, caller: Account, accessToken: string, input: QuoteInput): Promise<Quote>;
  /** Prepares one atomic request and allocation transaction, with `commandId` as its identity. */
  prepare(
    swapId: string,
    commandId: string,
    caller: Account,
    accessToken: string,
    terms: Terms,
  ): Promise<SigningPayload>;
  /** Verifies the wallet identity and signature locally, before the durable submission claim. */
  verify(signing: SigningPayload, signature: string, caller: Account): Promise<void>;
  submit(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation>;
  /** Evidence only. Absence is not proof of rejection and never causes a blind replay. */
  recover(pending: Pending): Promise<Confirmation | undefined>;
  /** Terminal settlement or direct wallet withdrawal, including while the backend was offline. */
  observe(confirmedSubmission: Pending): Promise<Confirmation | undefined>;
  prepareWithdrawal(commandId: string, swap: Swap, caller: Account, accessToken: string): Promise<SigningPayload>;
  withdraw(pending: Pending, caller: Account, accessToken: string): Promise<Confirmation>;
}

/** The durable swap requests and their preparations; `now` values are nanoseconds. */
export interface SwapProgress {
  saveQuote(quote: Quote, caller: Account): Promise<void>;
  quote(id: string, caller: Account): Promise<Quote>;
  preparedQuote(quoteId: string, caller: Account): Promise<Pending | undefined>;
  savePreparation(
    swapId: string,
    preparationId: string,
    commandId: string,
    quoteId: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending>;
  latestWithdrawal(swapId: string, caller: Account): Promise<Pending | undefined>;
  saveWithdrawal(
    swapId: string,
    preparationId: string,
    commandId: string,
    caller: Account,
    signing: SigningPayload,
    now: bigint,
  ): Promise<Pending>;
  begin(preparationId: string, caller: Account, signature: string, offset: bigint, now: bigint): Promise<boolean>;
  confirm(preparationId: string, confirmation: Confirmation): Promise<void>;
  uncertain(preparationId: string): Promise<void>;
  rejected(preparationId: string, failure: SwapRejected): Promise<void>;
  unresolved(): Promise<Pending[]>;
  tracked(): Promise<Pending[]>;
  pendingOwned(id: string, caller: Account): Promise<Pending>;
  owned(id: string, caller: Account): Promise<Swap>;
  activity(caller: Account, limit: number, cursor: string | null, status: string | null): Promise<Activity>;
}

/** The caller's history below a boundary, for the combined activity page. */
export interface SwapHistory {
  owned(id: string, caller: Account): Promise<Swap>;
  activityBefore(caller: Account, limit: number, before: Before | null, status: string | null): Promise<Activity>;
}
