import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { requireRole, type Account } from '../iam/accounts.js';
import { NUMERIC_SCALE, trimmedText } from '../platform/decimal.js';
import { Conflict, InvalidRequest } from '../platform/errors.js';
import { clockNanos, epochNanos, instantText, NANOS_PER_MICRO } from '../platform/time.js';
import { HASH_ENCODING, requireSignable, requireSignatureEncoding } from '../tokens/model.js';
import { plainAmount } from './math.js';
import {
  MAX_SLIPPAGE_BPS,
  type Activity,
  type Pending,
  type Preparation,
  type PrepareInput,
  type Quote,
  type QuoteInput,
  type Submission,
  type Swap,
  type Terms,
} from './model.js';
import { SwapRejected, type SwapLedger, type SwapProgress } from './ports.js';

/** The informational fee keeps four more digits than a token amount. */
const FEE_AMOUNT = /^(?:0|[1-9][0-9]{0,27})(?:\.([0-9]{1,14}))?$/;
const FEE_SCALE = 14;
const FEE_UNITS_PER_AMOUNT_UNIT = 10n ** BigInt(FEE_SCALE - NUMERIC_SCALE);

/** The informational fee may be smaller than a token quantum; it is not a separate transfer. */
function requireInformationalFee(fee: string, amountIn: string): void {
  const match = FEE_AMOUNT.exec(fee);
  if (!match) throw new InvalidRequest('Invalid informational fee');
  const whole = fee.split('.')[0] ?? '0';
  const scaled = BigInt(whole + (match[1] ?? '').padEnd(FEE_SCALE, '0'));
  if (scaled > plainAmount(amountIn, false) * FEE_UNITS_PER_AMOUNT_UNIT) throw new InvalidRequest('Fee exceeds input');
}

function approvedTerms(quote: Quote, input: PrepareInput): Terms {
  if (input.settlementDeadline % NANOS_PER_MICRO !== 0n) {
    throw new InvalidRequest('Settlement deadline must use microsecond precision');
  }
  const minimum = plainAmount(input.minOut, true);
  if (minimum > plainAmount(quote.expectedOut, false)) throw new InvalidRequest('Minimum output exceeds quoted output');
  if (input.settlementDeadline > epochNanos(quote.settlementDeadline)) {
    throw new InvalidRequest("Deadline exceeds quote's supported window");
  }
  return {
    poolId: quote.poolId,
    poolName: quote.poolName,
    trader: quote.trader,
    direction: quote.direction,
    inputInstrument: quote.inputInstrument,
    outputInstrument: quote.outputInstrument,
    amountIn: quote.amountIn,
    expectedOut: quote.expectedOut,
    feeAmount: quote.feeAmount,
    minOut: trimmedText(minimum),
    settlementDeadline: instantText(input.settlementDeadline),
  };
}

function requireSameTerms(swap: Swap, terms: Terms): void {
  if (
    plainAmount(swap.minOut, true) !== plainAmount(terms.minOut, true) ||
    epochNanos(swap.settlementDeadline) !== epochNanos(terms.settlementDeadline)
  ) {
    throw new Conflict('This quote was already prepared with different approved terms', 'IDEMPOTENCY_CONFLICT');
  }
}

function preparation(pending: Pending): Preparation {
  const { swap, signing } = pending;
  return {
    preparationId: pending.preparationId,
    swapId: swap.swapId,
    action: pending.action,
    terms: {
      poolId: swap.poolId,
      poolName: swap.poolName,
      trader: swap.trader,
      direction: swap.direction,
      inputInstrument: swap.inputInstrument,
      outputInstrument: swap.outputInstrument,
      amountIn: swap.amountIn,
      expectedOut: swap.expectedOut,
      feeAmount: swap.feeAmount,
      minOut: swap.minOut,
      settlementDeadline: swap.settlementDeadline,
    },
    preparedTransactionHash: signing.preparedTransactionHash,
    hashEncoding: HASH_ENCODING,
    hashingSchemeVersion: signing.hashingSchemeVersion,
    partyId: signing.partyId,
    publicKeyFingerprint: signing.publicKeyFingerprint,
    expiresAt: signing.expiresAt,
  };
}

/**
 * Signed swap requests: quote, prepare, submit, and reclaim after the deadline. Each preparation
 * is dispatched at most once; an unknown outcome is reconciled from ledger evidence, never resent.
 */
export class SwapWorkflow {
  constructor(
    private readonly store: SwapProgress,
    private readonly ledger: SwapLedger,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
    private readonly clock: () => bigint = clockNanos,
  ) {}

  async quote(caller: Account, accessToken: string, input: QuoteInput): Promise<Quote> {
    requireRole(caller, 'TRADER');
    plainAmount(input.amountIn, false);
    if (input.slippageBps < 0 || input.slippageBps > MAX_SLIPPAGE_BPS) throw new InvalidRequest('Invalid slippage');
    const id = randomUUID();
    const quote = await this.ledger.quote(id, caller, accessToken, input);
    if (
      quote.quoteId !== id ||
      quote.poolId !== input.poolId ||
      quote.direction !== input.direction ||
      plainAmount(quote.amountIn, false) !== plainAmount(input.amountIn, false)
    ) {
      throw new Error('Quote differs from requested terms');
    }
    plainAmount(quote.expectedOut, false);
    plainAmount(quote.minOut, true);
    requireInformationalFee(quote.feeAmount, quote.amountIn);
    await this.store.saveQuote(quote, caller);
    return quote;
  }

  async prepare(caller: Account, accessToken: string, input: PrepareInput): Promise<Preparation> {
    requireRole(caller, 'TRADER');
    const quote = await this.store.quote(input.quoteId, caller);
    const terms = approvedTerms(quote, input);
    const existing = await this.store.preparedQuote(input.quoteId, caller);
    if (existing) {
      requireSameTerms(existing.swap, terms);
      if (epochNanos(existing.signing.expiresAt) <= this.clock()) {
        throw new Conflict(
          'The signing window has elapsed. Check the existing request before requesting a new quote',
          'PREPARATION_EXPIRED',
        );
      }
      await this.ledger.requireAccess(caller, terms.poolId);
      return preparation(existing);
    }
    const now = this.clock();
    if (epochNanos(quote.quoteExpiresAt) <= now) throw new Conflict('Request a new quote', 'QUOTE_EXPIRED');
    if (epochNanos(terms.settlementDeadline) <= now) {
      throw new Conflict('The settlement deadline has elapsed', 'DEADLINE_ELAPSED');
    }
    const swapId = randomUUID();
    const preparationId = randomUUID();
    const signing = await this.ledger.prepare(swapId, swapId, caller, accessToken, terms);
    requireSignable(signing, terms.trader, now);
    const stored = await this.store.savePreparation(
      swapId,
      preparationId,
      swapId,
      input.quoteId,
      caller,
      terms,
      signing,
    );
    requireSameTerms(stored.swap, terms);
    return preparation(stored);
  }

  async submit(caller: Account, accessToken: string, input: Submission): Promise<Swap> {
    requireRole(caller, 'TRADER');
    const pending = await this.store.pendingOwned(input.preparationId, caller);
    if (pending.action !== 'SUBMIT') throw new Conflict('This preparation is for a withdrawal', 'PREPARATION_MISMATCH');
    return this.execute(caller, accessToken, input, pending);
  }

  async get(id: string, caller: Account): Promise<Swap> {
    requireRole(caller, 'TRADER');
    return this.store.owned(id, caller);
  }

  async activity(caller: Account, limit: number, cursor: string | null, status: string | null): Promise<Activity> {
    requireRole(caller, 'TRADER');
    return this.store.activity(caller, limit, cursor, status);
  }

  async prepareWithdrawal(swapId: string, caller: Account, accessToken: string): Promise<Preparation> {
    requireRole(caller, 'TRADER');
    const swap = await this.store.owned(swapId, caller);
    if (swap.status === 'SETTLED') throw new Conflict('The swap has already settled', 'WITHDRAWAL_UNAVAILABLE');
    const old = await this.store.latestWithdrawal(swapId, caller);
    if (old && (old.signature !== null || epochNanos(old.signing.expiresAt) > this.clock())) {
      await this.ledger.requireAccess(caller, swap.poolId);
      return preparation(old);
    }
    if (epochNanos(swap.settlementDeadline) > this.clock()) {
      throw new Conflict('Withdrawal is available after the settlement deadline', 'DEADLINE_NOT_ELAPSED');
    }
    if (!swap.canWithdraw) {
      throw new Conflict('No confirmed unsettled allocations are available to withdraw', 'WITHDRAWAL_UNAVAILABLE');
    }
    const command = randomUUID();
    const preparationId = randomUUID();
    const signing = await this.ledger.prepareWithdrawal(command, swap, caller, accessToken);
    requireSignable(signing, swap.trader, this.clock());
    return preparation(await this.store.saveWithdrawal(swapId, preparationId, command, caller, signing, this.clock()));
  }

  async withdraw(swapId: string, caller: Account, accessToken: string, input: Submission): Promise<Swap> {
    requireRole(caller, 'TRADER');
    const pending = await this.store.pendingOwned(input.preparationId, caller);
    if (pending.action !== 'WITHDRAW' || pending.swap.swapId !== swapId) {
      throw new Conflict('This preparation does not withdraw the selected swap', 'PREPARATION_MISMATCH');
    }
    return this.execute(caller, accessToken, input, pending);
  }

  private async execute(caller: Account, accessToken: string, input: Submission, pending: Pending): Promise<Swap> {
    requireSignatureEncoding(input.signature);
    if (pending.signature !== null) {
      if (pending.signature !== input.signature) {
        throw new Conflict('This preparation already has a different signature', 'IDEMPOTENCY_CONFLICT');
      }
      return this.store.owned(pending.swap.swapId, caller);
    }
    await this.ledger.verify(pending.signing, input.signature, caller);
    await this.ledger.requireAccess(caller, pending.swap.poolId);
    // One dispatch decision is durable before Canton is called; an unknown outcome is only read.
    const offset = await this.ledger.offset();
    if (await this.store.begin(input.preparationId, caller, input.signature, offset, this.clock())) {
      const claimed = await this.store.pendingOwned(input.preparationId, caller);
      try {
        const result =
          claimed.action === 'SUBMIT'
            ? await this.ledger.submit(claimed, caller, accessToken)
            : await this.ledger.withdraw(claimed, caller, accessToken);
        await this.store.confirm(input.preparationId, result);
      } catch (error) {
        if (error instanceof SwapRejected) {
          await this.store.rejected(input.preparationId, error);
        } else {
          await this.store.uncertain(input.preparationId);
          this.log.warn(
            { err: error, swap: claimed.swap.swapId, command: claimed.commandId },
            'Swap command awaits ledger confirmation',
          );
        }
      }
    }
    return this.store.owned(pending.swap.swapId, caller);
  }

  /** Recovers unknown submissions, then observes settlement or withdrawal of confirmed requests. */
  async reconcile(): Promise<void> {
    for (const pending of await this.store.unresolved()) {
      try {
        const confirmation = await this.ledger.recover(pending);
        if (confirmation) await this.store.confirm(pending.preparationId, confirmation);
      } catch (error) {
        if (error instanceof SwapRejected) await this.store.rejected(pending.preparationId, error);
        else this.log.warn({ err: error, swap: pending.swap.swapId }, 'Swap reconciliation failed');
      }
    }
    for (const pending of await this.store.tracked()) {
      try {
        const confirmation = await this.ledger.observe(pending);
        if (!confirmation) continue;
        if (confirmation.status !== 'SETTLED' && confirmation.status !== 'WITHDRAWN') {
          throw new Error('Non-terminal completion observation');
        }
        await this.store.confirm(pending.preparationId, confirmation);
      } catch (error) {
        this.log.warn({ err: error, swap: pending.swap.swapId }, 'Swap completion observation failed');
      }
    }
  }
}
