import type { InstrumentId } from './pool.js';

export type LiquidityKind = 'DEPOSIT' | 'WITHDRAW';

/** `INITIAL` seeds an empty pool at its configured ratio; `PROPORTIONAL` joins at the reserves. */
export type DepositMode = 'INITIAL' | 'PROPORTIONAL';

export type LiquidityAction = 'SUBMIT' | 'RECOVER';

/**
 * `EXPIRED` means the deadline passed and nothing is recovered yet; only
 * `RECOVERED` releases the allocations. `FAILED` requests created none.
 */
export type LiquidityStatus =
  | 'PREPARED'
  | 'SUBMITTING'
  | 'UNRESOLVED'
  | 'READY'
  | 'BLOCKED'
  | 'SETTLING'
  | 'SETTLED'
  | 'EXPIRED'
  | 'RECOVERING'
  | 'RECOVERY_UNRESOLVED'
  | 'RECOVERED'
  | 'FAILED';

/** Every amount in this module is a decimal string. */
export interface DepositQuoteInput {
  poolId: string;
  maxBaseAmount: string;
  maxQuoteAmount: string;
  slippageBps: number;
}

export interface WithdrawalQuoteInput {
  poolId: string;
  lpAmount: string;
  slippageBps: number;
}

interface SharedTerms {
  poolId: string;
  poolName: string;
  trader: string;
  baseInstrument: InstrumentId;
  quoteInstrument: InstrumentId;
  lpInstrument: InstrumentId;
  settlementDeadline: string;
}

export interface DepositTerms extends SharedTerms {
  mode: DepositMode;
  maxBaseAmount: string;
  maxQuoteAmount: string;
  expectedBaseAmount: string;
  expectedQuoteAmount: string;
  expectedBaseRefund: string;
  expectedQuoteRefund: string;
  expectedLpOut: string;
  minLpOut: string;
  minRatio: string;
  maxRatio: string;
  /** LP locked in the pool and never minted; null on a proportional deposit. */
  initialMinimumLp: string | null;
}

export interface WithdrawalTerms extends SharedTerms {
  lpAmount: string;
  expectedBaseOut: string;
  expectedQuoteOut: string;
  minBaseOut: string;
  minQuoteOut: string;
}

interface QuoteFields {
  quoteId: string;
  stateId: string;
  quoteExpiresAt: string;
  slippageBps: number;
}

/** Expected figures are estimates; the minimums and ratio bounds are what the trader signs. */
export type DepositQuote = DepositTerms & QuoteFields;
export type WithdrawalQuote = WithdrawalTerms & QuoteFields;

export interface PrepareDepositInput {
  quoteId: string;
  minLpOut: string;
  minRatio: string;
  maxRatio: string;
  settlementDeadline: string;
}

export interface PrepareWithdrawalInput {
  quoteId: string;
  minBaseOut: string;
  minQuoteOut: string;
  settlementDeadline: string;
}

/** `RELEASE_PERMISSION` withdraws a receipt authorization and returns no funds. */
export type RecoveryKind = 'RETURN_FUNDS' | 'RELEASE_PERMISSION';

export interface RecoveryEffect {
  allocationCid: string;
  instrument: InstrumentId;
  amount: string;
  kind: RecoveryKind;
}

/** One hash covering all three allocations, signed by the wallet unchanged. */
export interface LiquidityPreparation<Terms> {
  preparationId: string;
  requestId: string;
  action: LiquidityAction;
  terms: Terms;
  preparedTransactionHash: string;
  hashEncoding: string;
  hashingSchemeVersion: number;
  partyId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
  /** Empty unless `action` is `RECOVER`. */
  recoveryEffects: readonly RecoveryEffect[];
}

export type DepositPreparation = LiquidityPreparation<DepositTerms>;
export type WithdrawalPreparation = LiquidityPreparation<WithdrawalTerms>;

export interface DepositResult {
  actualBaseIn: string;
  actualQuoteIn: string;
  actualBaseRefund: string;
  actualQuoteRefund: string;
  actualLpOut: string;
}

export interface WithdrawalResult {
  actualLpBurned: string;
  actualBaseOut: string;
  actualQuoteOut: string;
}

interface LiquidityRecord<Kind extends LiquidityKind, Terms, Result> {
  requestId: string;
  quoteId: string;
  kind: Kind;
  terms: Terms;
  /** Null until a batch settles the request. */
  result: Result | null;
  status: LiquidityStatus;
  arrivalSequence: number | null;
  createdAt: string;
  submittedAt: string | null;
  updatedAt: string;
  settlementId: string | null;
  allocationCids: readonly string[];
  updateId: string | null;
  errorCode: string | null;
  error: string | null;
  canRecover: boolean;
}

export type DepositRequest = LiquidityRecord<'DEPOSIT', DepositTerms, DepositResult>;
export type WithdrawalRequest = LiquidityRecord<'WITHDRAW', WithdrawalTerms, WithdrawalResult>;
export type LiquidityRequest = DepositRequest | WithdrawalRequest;

export interface LiquidityActivity<Request extends LiquidityRequest> {
  items: readonly Request[];
  nextCursor: string | null;
}

export interface LiquidityActivityQuery {
  status?: LiquidityStatus;
  limit?: number;
  cursor?: string;
}

/** `allocatedLp` is locked in unsettled withdrawals; values are computed by the venue. */
export interface LpPosition {
  poolId: string;
  poolName: string;
  baseInstrument: InstrumentId;
  quoteInstrument: InstrumentId;
  lpInstrument: InstrumentId;
  availableLp: string;
  allocatedLp: string;
  totalLp: string;
  lpTokenSupply: string;
  share: string;
  baseValue: string;
  quoteValue: string;
}

export interface LpPositions {
  items: readonly LpPosition[];
  asOfOffset: number;
}
