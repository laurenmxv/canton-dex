import type { Pool, QuoteInput, SwapPreparation, SwapQuote, SwapRequest } from '../../lib/api/types';
import { BPS_SCALE, DomainError, MAX_SLIPPAGE_BPS } from '../../lib/api/types';
import { findOnboardingForAccount } from './onboarding';
import {
  decimal,
  floorDecimal,
  nextId,
  now,
  positive,
  QUOTE_TTL_MS,
  requireIdentity,
  SETTLEMENT_TTL_MS,
  type DemoState,
} from './state';

// --------------------------------------------------------------------- swaps

export function eligiblePools(state: DemoState, accountId: string): Pool[] {
  const onboarding = findOnboardingForAccount(state, accountId);
  if (!onboarding || onboarding.status !== 'COMPLETED') return [];
  const approved = new Set(onboarding.review?.approvedPoolIds ?? []);
  return state.pools.filter((pool) => approved.has(pool.poolId));
}

/** Matches `Lib.Math.swapOutput`: constant product after taking the fee on input. */
export function swapOutput(
  feeBps: number,
  reserveIn: number,
  reserveOut: number,
  amountIn: number,
): number {
  const netInput = (amountIn * (BPS_SCALE - feeBps)) / BPS_SCALE;
  return (reserveOut * netInput) / (reserveIn + netInput);
}

export function quoteSwap(state: DemoState, accountId: string, input: QuoteInput): SwapQuote {
  const pool = eligiblePools(state, accountId).find(
    (candidate) => candidate.poolId === input.poolId,
  );
  if (!pool) throw new DomainError('Pool is not available to this account', 'NOT_FOUND');
  const amountIn = positive(input.amountIn);
  if (!(input.slippageBps >= 0 && input.slippageBps <= MAX_SLIPPAGE_BPS)) {
    throw new DomainError(`Slippage must be between 0 and ${MAX_SLIPPAGE_BPS} bps`, 'VALIDATION');
  }
  const base = Number(pool.baseReserve);
  const quote = Number(pool.quoteReserve);
  const [reserveIn, reserveOut] =
    input.direction === 'BaseToQuote' ? [base, quote] : [quote, base];
  const expectedOut = swapOutput(pool.feeBps, reserveIn, reserveOut, amountIn);
  if (!(expectedOut > 0)) {
    throw new DomainError('This amount yields no output', 'VALIDATION');
  }
  const issued = Date.now();
  const swapQuote: SwapQuote = {
    quoteId: nextId(state, 'quote'),
    poolId: pool.poolId,
    direction: input.direction,
    amountIn: decimal(amountIn),
    expectedOut: floorDecimal(expectedOut),
    feeAmount: floorDecimal((amountIn * pool.feeBps) / BPS_SCALE),
    minOut: floorDecimal((expectedOut * (BPS_SCALE - input.slippageBps)) / BPS_SCALE),
    slippageBps: input.slippageBps,
    quoteExpiresAt: new Date(issued + QUOTE_TTL_MS).toISOString(),
    settlementDeadline: new Date(issued + SETTLEMENT_TTL_MS).toISOString(),
  };
  state.quotes.push({ owner: accountId, value: swapQuote, spentBy: null });
  return swapQuote;
}

/** A quote backs one preparation. Preparing twice returns the first one. */
export function prepareSwap(
  state: DemoState,
  accountId: string,
  quoteId: string,
): SwapPreparation {
  const owned = state.quotes.find((candidate) => candidate.value.quoteId === quoteId);
  // An unknown quote and another account's quote are indistinguishable here.
  if (!owned || owned.owner !== accountId) {
    throw new DomainError('Quote not found', 'NOT_FOUND');
  }
  if (owned.spentBy) {
    const existing = state.preparations.find(
      (candidate) => candidate.value.preparationId === owned.spentBy,
    );
    if (existing) return existing.value;
  }
  if (Date.parse(owned.value.quoteExpiresAt) <= Date.now()) {
    throw new DomainError('Quote expired, request a new one', 'EXPIRED');
  }
  const preparation: SwapPreparation = {
    preparationId: nextId(state, 'swapprep'),
    quoteId,
    commandDigest: `sha256:${quoteId.replace(/-/g, '')}9f2c41d8e7b0`,
  };
  owned.spentBy = preparation.preparationId;
  state.preparations.push({ owner: accountId, value: preparation, spentBy: null });
  return preparation;
}

export function swapRequestsFor(state: DemoState, accountId: string): SwapRequest[] {
  const identity = requireIdentity(state, accountId);
  return state.swapRequests.filter((request) => request.trader === identity.fixturePartyId);
}

/** Resubmitting a preparation returns the request it already produced. */
export function submitSwap(
  state: DemoState,
  accountId: string,
  preparationId: string,
): SwapRequest {
  const owned = state.preparations.find(
    (candidate) => candidate.value.preparationId === preparationId,
  );
  // Another account's preparation must look exactly like one that never existed.
  if (!owned || owned.owner !== accountId) {
    throw new DomainError('Preparation not found', 'NOT_FOUND');
  }
  if (owned.spentBy) {
    const existing = state.swapRequests.find((request) => request.requestId === owned.spentBy);
    if (existing) return existing;
  }
  const quote = state.quotes.find(
    (candidate) => candidate.value.quoteId === owned.value.quoteId,
  )?.value;
  if (!quote) throw new DomainError('Quote not found', 'NOT_FOUND');
  if (Date.parse(quote.settlementDeadline) <= Date.now()) {
    throw new DomainError('Settlement deadline passed, request a new quote', 'EXPIRED');
  }
  const pool = state.pools.find((candidate) => candidate.poolId === quote.poolId);
  const request: SwapRequest = {
    requestId: nextId(state, 'swap'),
    poolId: quote.poolId,
    poolName: pool?.name ?? quote.poolId,
    trader: requireIdentity(state, accountId).fixturePartyId,
    direction: quote.direction,
    amountIn: quote.amountIn,
    minOut: quote.minOut,
    expectedOut: quote.expectedOut,
    // The demo stops here. Settlement is out of scope and never simulated.
    status: 'AWAITING_SETTLEMENT',
    submittedAt: now(),
    settlementDeadline: quote.settlementDeadline,
  };
  owned.spentBy = request.requestId;
  state.swapRequests.push(request);
  return request;
}
