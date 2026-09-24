import type { StaticDecode } from 'typebox';
import type { Family } from '../platform/families.js';
import { storedEnum, storedInt, storedList, storedNullableText, storedObject, storedText } from '../platform/stored.js';
import { Instrument, SigningPayload as ParticipantSigningPayload } from '../tokens/model.js';

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

const POOL = {
  poolId: storedText,
  poolName: storedText,
  trader: storedText,
  baseInstrument: Instrument,
  quoteInstrument: Instrument,
  lpInstrument: Instrument,
};

const DEPOSIT = {
  ...POOL,
  mode: storedEnum(MODES),
  maxBaseAmount: storedText,
  maxQuoteAmount: storedText,
  expectedBaseAmount: storedText,
  expectedQuoteAmount: storedText,
  expectedBaseRefund: storedText,
  expectedQuoteRefund: storedText,
  expectedLpOut: storedText,
  minLpOut: storedText,
  minRatio: storedText,
  maxRatio: storedText,
  /** LP locked in the pool and never minted; null on a proportional deposit. */
  initialMinimumLp: storedNullableText,
};

const WITHDRAWAL = {
  ...POOL,
  lpAmount: storedText,
  expectedBaseOut: storedText,
  expectedQuoteOut: storedText,
  minBaseOut: storedText,
  minQuoteOut: storedText,
};

export const DepositTerms = storedObject({ ...DEPOSIT, settlementDeadline: storedText });
export type DepositTerms = StaticDecode<typeof DepositTerms>;
export const WithdrawalTerms = storedObject({ ...WITHDRAWAL, settlementDeadline: storedText });
export type WithdrawalTerms = StaticDecode<typeof WithdrawalTerms>;
export type Terms = DepositTerms | WithdrawalTerms;

const QUOTE = {
  slippageBps: storedInt,
  stateId: storedText,
  quoteExpiresAt: storedText,
  settlementDeadline: storedText,
};

/** Expected figures are estimates; the minimums and ratio bounds are what the trader signs. */
export const DepositQuote = storedObject({ quoteId: storedText, ...DEPOSIT, ...QUOTE });
export type DepositQuote = StaticDecode<typeof DepositQuote>;
export const WithdrawalQuote = storedObject({ quoteId: storedText, ...WITHDRAWAL, ...QUOTE });
export type WithdrawalQuote = StaticDecode<typeof WithdrawalQuote>;

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

export const DepositResult = storedObject({
  actualBaseIn: storedText,
  actualQuoteIn: storedText,
  actualBaseRefund: storedText,
  actualQuoteRefund: storedText,
  actualLpOut: storedText,
});
export type DepositResult = StaticDecode<typeof DepositResult>;

export const WithdrawalResult = storedObject({
  actualLpBurned: storedText,
  actualBaseOut: storedText,
  actualQuoteOut: storedText,
});
export type WithdrawalResult = StaticDecode<typeof WithdrawalResult>;
export type Result = DepositResult | WithdrawalResult;

export const RecoveryEffect = storedObject({
  allocationCid: storedText,
  instrument: Instrument,
  amount: storedText,
  kind: storedEnum(RECOVERY_KINDS),
});
export type RecoveryEffect = StaticDecode<typeof RecoveryEffect>;

/** The opaque transaction remains in the backend; wallets sign its participant hash. */
export const SigningPayload = storedObject({
  ...ParticipantSigningPayload.properties,
  recoveryEffects: storedList(RecoveryEffect),
});
export type SigningPayload = StaticDecode<typeof SigningPayload>;

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
