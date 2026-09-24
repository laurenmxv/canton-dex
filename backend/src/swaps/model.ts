import type { StaticDecode } from 'typebox';
import { storedEnum, storedInt, storedObject, storedText } from '../platform/stored.js';
import { Instrument, type SigningPayload } from '../tokens/model.js';

export { SigningPayload } from '../tokens/model.js';

export const DIRECTIONS = ['BaseToQuote', 'QuoteToBase'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const SWAP_STATUSES = [
  'PREPARED',
  'SUBMITTING',
  'UNRESOLVED',
  'READY',
  'BLOCKED',
  'SETTLING',
  'SETTLED',
  'EXPIRED',
  'WITHDRAWING',
  'WITHDRAWAL_UNRESOLVED',
  'WITHDRAWN',
  'FAILED',
] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

/** The largest slippage tolerance a trader may sign, in basis points. */
export const MAX_SLIPPAGE_BPS = 5_000;

/** What a preparation authorizes: entering the queue, or reclaiming its allocations. */
export type SwapAction = 'SUBMIT' | 'WITHDRAW';

export interface QuoteInput {
  readonly poolId: string;
  readonly direction: Direction;
  readonly amountIn: string;
  readonly slippageBps: number;
}

/** The fields that a quote and the terms it approves share. */
const TRADE = {
  poolId: storedText,
  poolName: storedText,
  trader: storedText,
  direction: storedEnum(DIRECTIONS),
  inputInstrument: Instrument,
  outputInstrument: Instrument,
  amountIn: storedText,
  expectedOut: storedText,
  feeAmount: storedText,
  minOut: storedText,
};

export const Quote = storedObject({
  quoteId: storedText,
  ...TRADE,
  slippageBps: storedInt,
  stateId: storedText,
  quoteExpiresAt: storedText,
  settlementDeadline: storedText,
});
export type Quote = StaticDecode<typeof Quote>;

export interface PrepareInput {
  readonly quoteId: string;
  readonly minOut: string;
  /** Nanoseconds since the epoch, so a submicrosecond value can be refused. */
  readonly settlementDeadline: bigint;
}

export interface Submission {
  readonly preparationId: string;
  readonly signature: string;
}

/** The immutable terms a preparation binds. */
export const Terms = storedObject({ ...TRADE, settlementDeadline: storedText });
export type Terms = StaticDecode<typeof Terms>;

export interface Preparation {
  readonly preparationId: string;
  readonly swapId: string;
  readonly action: SwapAction;
  readonly terms: Terms;
  readonly preparedTransactionHash: string;
  readonly hashEncoding: string;
  readonly hashingSchemeVersion: number;
  readonly partyId: string;
  readonly publicKeyFingerprint: string;
  readonly expiresAt: string;
}

export interface Swap extends Terms {
  readonly swapId: string;
  readonly quoteId: string;
  readonly status: SwapStatus;
  readonly arrivalSequence: bigint | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly settlementId: string | null;
  readonly amountOut: string | null;
  readonly allocationCids: readonly string[];
  readonly updateId: string | null;
  readonly errorCode: string | null;
  readonly error: string | null;
  readonly canWithdraw: boolean;
}

export interface Activity {
  readonly items: readonly Swap[];
  readonly nextCursor: string | null;
}

/** Persisted work, and the ledger adapter's immutable submission and recovery input. */
export interface Pending {
  readonly swap: Swap;
  readonly accountId: string;
  readonly preparationId: string;
  readonly commandId: string;
  readonly action: SwapAction;
  readonly signing: SigningPayload;
  readonly signature: string | null;
  readonly beginOffset: bigint;
}

export interface Confirmation {
  readonly status: SwapStatus;
  readonly allocationCids: readonly string[];
  readonly amountOut: string | null;
  readonly updateId: string;
  readonly offset: bigint;
  readonly confirmedAt: string;
}

/** A page boundary of the caller's history: the creation time and id of the last item read. */
export interface Before {
  readonly createdAt: string;
  readonly id: string;
}
