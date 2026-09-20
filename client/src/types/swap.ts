import type { InstrumentId } from './pool.js';

/** Which side of the pair the trader pays in. */
export type SwapDirection = 'BaseToQuote' | 'QuoteToBase';

/**
 * Where one request stands. Each value is a distinct fact, and none of them is
 * derived from another:
 *
 * - `PREPARED`: terms are approved by the venue and await the trader's signature.
 * - `SUBMITTING`: the signature was accepted and the transaction is on its way.
 * - `UNRESOLVED`: the submission's outcome is unknown and is being reconciled.
 * - `READY`: the ledger confirmed both allocations. It is queued.
 * - `BLOCKED`: it is still first in line but cannot settle at the current reserves.
 * - `SETTLING`: a batch carrying it has been submitted.
 * - `SETTLED`: the batch committed, and `amountOut` is what was paid.
 * - `EXPIRED`: the settlement deadline elapsed. The input stays locked.
 * - `WITHDRAWING`, `WITHDRAWAL_UNRESOLVED`, `WITHDRAWN`: the reclaim's three steps.
 *   Only `WITHDRAWN` means the allocations are released.
 * - `FAILED`: the ledger refused the request, and `errorCode` says why.
 */
export type SwapStatus =
  | 'PREPARED'
  | 'SUBMITTING'
  | 'UNRESOLVED'
  | 'READY'
  | 'BLOCKED'
  | 'SETTLING'
  | 'SETTLED'
  | 'EXPIRED'
  | 'WITHDRAWING'
  | 'WITHDRAWAL_UNRESOLVED'
  | 'WITHDRAWN'
  | 'FAILED';

/** What a preparation authorizes: entering the queue, or leaving it. */
export type SwapAction = 'SUBMIT' | 'WITHDRAW';

/**
 * What to price. Every amount is a decimal string, as the ledger stores it.
 *
 * `slippageBps` is basis points between 0 and 5000, and it is what turns the
 * quoted output into the minimum the trader will sign for.
 */
export interface SwapQuoteInput {
  poolId: string;
  direction: SwapDirection;
  amountIn: string;
  slippageBps: number;
}

/**
 * An estimate, taken against one observed pool state.
 *
 * `expectedOut` is what that state would pay; a batch prices each request
 * again, in order, against the reserves that hold when it runs, so the amount
 * actually paid differs. `minOut` is the one figure the trader signs and the
 * pool must honour. `quoteExpiresAt` bounds how long this quote can still be
 * prepared from, and `stateId` names the state it was taken against.
 */
export interface SwapQuote {
  quoteId: string;
  poolId: string;
  poolName: string;
  trader: string;
  direction: SwapDirection;
  inputInstrument: InstrumentId;
  outputInstrument: InstrumentId;
  amountIn: string;
  /** What the observed state would pay. The batch decides the real amount. */
  expectedOut: string;
  /** Informational: it is taken from the input, not transferred separately. */
  feeAmount: string;
  minOut: string;
  slippageBps: number;
  stateId: string;
  quoteExpiresAt: string;
  settlementDeadline: string;
}

/**
 * The terms the trader approves. `minOut` may be no larger than the quote's
 * expected output, and `settlementDeadline` no later than the quote's, so both
 * are normally sent back exactly as the quote gave them.
 */
export interface PrepareSwapInput {
  quoteId: string;
  minOut: string;
  settlementDeadline: string;
}

/** One signature over one preparation, both as the venue produced them. */
export interface SubmitSignatureInput {
  preparationId: string;
  /** ASN.1 DER ECDSA or Ed25519, base64. */
  signature: string;
}

/** The immutable terms a preparation binds, repeated back for confirmation. */
export interface SwapTerms {
  poolId: string;
  poolName: string;
  trader: string;
  direction: SwapDirection;
  inputInstrument: InstrumentId;
  outputInstrument: InstrumentId;
  amountIn: string;
  expectedOut: string;
  feeAmount: string;
  minOut: string;
  settlementDeadline: string;
}

/**
 * What the wallet is asked to sign.
 *
 * The transaction itself stays in the backend: only its hash crosses this
 * boundary, and the wallet signs those exact bytes without rebuilding or
 * re-hashing anything. `hashingSchemeVersion` says what the hash covers, and
 * `publicKeyFingerprint` says which registered key must produce the signature.
 */
export interface SwapPreparation {
  preparationId: string;
  swapId: string;
  action: SwapAction;
  terms: SwapTerms;
  preparedTransactionHash: string;
  /** `base64`, as every venue preparation encodes its hash today. */
  hashEncoding: string;
  hashingSchemeVersion: number;
  partyId: string;
  publicKeyFingerprint: string;
  expiresAt: string;
}

/**
 * One request and everything the venue knows about it.
 *
 * `arrivalSequence` is the pool's own FIFO position, assigned when the request
 * was accepted. `amountOut` is null until a batch settles it, and is then the
 * amount actually paid, which can exceed `minOut`.
 */
export interface Swap {
  swapId: string;
  quoteId: string;
  poolId: string;
  poolName: string;
  trader: string;
  direction: SwapDirection;
  inputInstrument: InstrumentId;
  outputInstrument: InstrumentId;
  amountIn: string;
  expectedOut: string;
  feeAmount: string;
  minOut: string;
  settlementDeadline: string;
  status: SwapStatus;
  arrivalSequence: number | null;
  createdAt: string;
  submittedAt: string | null;
  updatedAt: string;
  settlementId: string | null;
  amountOut: string | null;
  allocationCids: readonly string[];
  updateId: string | null;
  errorCode: string | null;
  error: string | null;
  /** The venue's own answer on whether a reclaim can be prepared right now. */
  canWithdraw: boolean;
}

/** One page of the caller's own requests, newest first. */
export interface SwapActivity {
  items: readonly Swap[];
  /** Null on the last page. Pass it back as `cursor` for the next one. */
  nextCursor: string | null;
}

/** Narrows the caller's history. An omitted field is not sent at all. */
export interface SwapActivityQuery {
  status?: SwapStatus;
  /** Between 1 and 100. The route's own default applies when omitted. */
  limit?: number;
  cursor?: string;
}
