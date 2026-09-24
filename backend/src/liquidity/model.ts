import type { Family } from '../platform/database.js';
import type { Instrument } from '../tokens/model.js';

export const KINDS = ['DEPOSIT', 'WITHDRAW'] as const;
export type Kind = (typeof KINDS)[number];
export const MODES = ['INITIAL', 'PROPORTIONAL'] as const;
export type Mode = (typeof MODES)[number];
export type LiquidityAction = 'SUBMIT' | 'RECOVER';
export const LIQUIDITY_STATUSES = [
  'PREPARED',
  'SUBMITTING',
  'UNRESOLVED',
  'READY',
  'BLOCKED',
  'SETTLING',
  'SETTLED',
  'EXPIRED',
  'RECOVERING',
  'RECOVERY_UNRESOLVED',
  'RECOVERED',
  'FAILED',
] as const;
export type LiquidityStatus = (typeof LIQUIDITY_STATUSES)[number];
export const RECOVERY_KINDS = ['RETURN_FUNDS', 'RELEASE_PERMISSION'] as const;
/** `RELEASE_PERMISSION` withdraws a receipt authorization and returns no funds. */
export type RecoveryKind = (typeof RECOVERY_KINDS)[number];

export interface DepositQuoteInput {
  readonly poolId: string;
  readonly maxBaseAmount: string;
  readonly maxQuoteAmount: string;
  readonly slippageBps: number;
}

export interface WithdrawalQuoteInput {
  readonly poolId: string;
  readonly lpAmount: string;
  readonly slippageBps: number;
}

export interface DepositTerms {
  readonly poolId: string;
  readonly poolName: string;
  readonly trader: string;
  readonly baseInstrument: Instrument;
  readonly quoteInstrument: Instrument;
  readonly lpInstrument: Instrument;
  readonly mode: Mode;
  readonly maxBaseAmount: string;
  readonly maxQuoteAmount: string;
  readonly expectedBaseAmount: string;
  readonly expectedQuoteAmount: string;
  readonly expectedBaseRefund: string;
  readonly expectedQuoteRefund: string;
  readonly expectedLpOut: string;
  readonly minLpOut: string;
  readonly minRatio: string;
  readonly maxRatio: string;
  /** LP locked in the pool and never minted; null on a proportional deposit. */
  readonly initialMinimumLp: string | null;
  readonly settlementDeadline: string;
}

export interface WithdrawalTerms {
  readonly poolId: string;
  readonly poolName: string;
  readonly trader: string;
  readonly baseInstrument: Instrument;
  readonly quoteInstrument: Instrument;
  readonly lpInstrument: Instrument;
  readonly lpAmount: string;
  readonly expectedBaseOut: string;
  readonly expectedQuoteOut: string;
  readonly minBaseOut: string;
  readonly minQuoteOut: string;
  readonly settlementDeadline: string;
}

export type Terms = DepositTerms | WithdrawalTerms;

interface QuoteFields {
  readonly quoteId: string;
  readonly slippageBps: number;
  readonly stateId: string;
  readonly quoteExpiresAt: string;
}

/** Expected figures are estimates; the minimums and ratio bounds are what the trader signs. */
export type DepositQuote = DepositTerms & QuoteFields;
export type WithdrawalQuote = WithdrawalTerms & QuoteFields;

export interface PrepareDepositInput {
  readonly quoteId: string;
  readonly minLpOut: string;
  readonly minRatio: string;
  readonly maxRatio: string;
  /** Nanoseconds since the epoch. */
  readonly settlementDeadline: bigint;
}

export interface PrepareWithdrawalInput {
  readonly quoteId: string;
  readonly minBaseOut: string;
  readonly minQuoteOut: string;
  /** Nanoseconds since the epoch. */
  readonly settlementDeadline: bigint;
}

export interface DepositResult {
  readonly actualBaseIn: string;
  readonly actualQuoteIn: string;
  readonly actualBaseRefund: string;
  readonly actualQuoteRefund: string;
  readonly actualLpOut: string;
}

export interface WithdrawalResult {
  readonly actualLpBurned: string;
  readonly actualBaseOut: string;
  readonly actualQuoteOut: string;
}

export type Result = DepositResult | WithdrawalResult;

export interface RecoveryEffect {
  readonly allocationCid: string;
  readonly instrument: Instrument;
  readonly amount: string;
  readonly kind: RecoveryKind;
}

/** The opaque transaction remains in the backend; wallets sign its participant hash. */
export interface SigningPayload {
  readonly preparedTransaction: string;
  readonly preparedTransactionHash: string;
  readonly hashingSchemeVersion: number;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  readonly expiresAt: string;
  readonly recoveryEffects: readonly RecoveryEffect[];
}

export interface Preparation {
  readonly preparationId: string;
  readonly requestId: string;
  readonly action: LiquidityAction;
  readonly terms: Terms;
  readonly preparedTransactionHash: string;
  readonly hashEncoding: string;
  readonly hashingSchemeVersion: number;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  readonly expiresAt: string;
  readonly recoveryEffects: readonly RecoveryEffect[];
}

export interface Request {
  readonly requestId: string;
  readonly quoteId: string;
  readonly kind: Kind;
  readonly terms: Terms;
  readonly status: LiquidityStatus;
  readonly arrivalSequence: bigint | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly settlementId: string | null;
  readonly result: Result | null;
  readonly allocationCids: readonly string[];
  readonly updateId: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly canRecover: boolean;
}

export interface Activity {
  readonly items: readonly Request[];
  readonly nextCursor: string | null;
}

export interface Pending {
  readonly request: Request;
  readonly accountId: string;
  readonly preparationId: string;
  readonly commandId: string;
  readonly action: LiquidityAction;
  readonly signing: SigningPayload;
  readonly signature: string | null;
  readonly beginOffset: bigint;
}

export interface Confirmation {
  readonly status: LiquidityStatus;
  readonly allocationCids: readonly string[];
  readonly result: Result | null;
  readonly updateId: string;
  readonly offset: bigint;
  readonly confirmedAt: string;
}

export interface Position {
  readonly poolId: string;
  readonly poolName: string;
  readonly baseInstrument: Instrument;
  readonly quoteInstrument: Instrument;
  readonly lpInstrument: Instrument;
  readonly availableLp: string;
  readonly allocatedLp: string;
  readonly totalLp: string;
  readonly lpTokenSupply: string;
  readonly share: string;
  readonly baseValue: string;
  readonly quoteValue: string;
}

export interface Positions {
  readonly items: readonly Position[];
  readonly asOfOffset: bigint;
}

export function isDepositTerms(terms: Terms): terms is DepositTerms {
  return 'mode' in terms;
}

export function kindOf(terms: Terms): Kind {
  return isDepositTerms(terms) ? 'DEPOSIT' : 'WITHDRAW';
}

/** The settlement queue of a request kind. */
export function familyOf(kind: Kind): Family {
  return kind === 'DEPOSIT' ? 'deposit' : 'withdraw';
}
