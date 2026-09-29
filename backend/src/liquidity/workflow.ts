/**
 * Quotes and tracks deposits and LP withdrawals.
 *
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { requireRole, type Account } from '../iam/accounts.js';
import { trimmedText } from '../platform/decimal.js';
import { Conflict, InvalidRequest, NotFound } from '../platform/errors.js';
import { jsonText } from '../platform/json.js';
import { clockNanos, epochNanos, instantText, NANOS_PER_MICRO } from '../platform/time.js';
import { plainAmount } from '../swaps/math.js';
import { MAX_SLIPPAGE_BPS, type Submission } from '../swaps/model.js';
import { HASH_ENCODING, requireSignable, requireSignatureEncoding } from '../tokens/model.js';
import type {
  Activity,
  DepositQuote,
  DepositQuoteInput,
  DepositTerms,
  Kind,
  Pending,
  Positions,
  Preparation,
  PrepareDepositInput,
  PrepareWithdrawalInput,
  Request,
  Terms,
  WithdrawalQuote,
  WithdrawalQuoteInput,
  WithdrawalTerms,
} from './model.js';
import { LiquidityRejected, type LiquidityLedger, type LiquidityProgress } from './ports.js';

function requireSlippage(bps: number): void {
  if (bps < 0 || bps > MAX_SLIPPAGE_BPS) throw new InvalidRequest('Invalid slippage');
}

function requireMinimum(value: string, expected: string): void {
  if (plainAmount(value, true) > plainAmount(expected, false)) {
    throw new InvalidRequest('Minimum output exceeds quoted output');
  }
}

/** The approved deadline, which may not exceed the quote's and must have microsecond precision. */
function approvedDeadline(approved: bigint, quoted: string): string {
  if (approved % NANOS_PER_MICRO !== 0n) throw new InvalidRequest('Deadline must use microsecond precision');
  if (approved > epochNanos(quoted)) throw new InvalidRequest("Deadline exceeds quote's supported window");
  return instantText(approved);
}

/** The value's plain text without trailing fraction zeros; it was validated as a plain amount. */
function canonical(value: string): string {
  return trimmedText(plainAmount(value, true));
}

function requireSameTerms(stored: Terms, requested: Terms): void {
  // Both sides are built field by field in the same order, from canonical decimal and instant text.
  if (jsonText(stored) !== jsonText(requested)) {
    throw new Conflict('This quote was already prepared with different terms', 'IDEMPOTENCY_CONFLICT');
  }
}

function requireKind(request: Request, kind: Kind): Request {
  if (request.kind !== kind) throw new NotFound();
  return request;
}

function preparation(pending: Pending): Preparation {
  const { signing } = pending;
  return {
    preparationId: pending.preparationId,
    requestId: pending.request.requestId,
    action: pending.action,
    terms: pending.request.terms,
    preparedTransactionHash: signing.preparedTransactionHash,
    hashEncoding: HASH_ENCODING,
    hashingSchemeVersion: signing.hashingSchemeVersion,
    partyId: signing.partyId,
    publicKeyFingerprint: signing.publicKeyFingerprint,
    expiresAt: signing.expiresAt,
    recoveryEffects: signing.recoveryEffects,
  };
}

/**
 * Signed LP deposits and withdrawals, and recovery of their allocations after the deadline. Each
 * preparation is dispatched at most once; unknown outcomes are reconciled, never blindly resent.
 */
export class LiquidityWorkflow {
  constructor(
    private readonly store: LiquidityProgress,
    private readonly ledger: LiquidityLedger,
    private readonly log: Pick<FastifyBaseLogger, 'warn'>,
    private readonly clock: () => bigint = clockNanos,
  ) {}

  async quoteDeposit(caller: Account, accessToken: string, input: DepositQuoteInput): Promise<DepositQuote> {
    requireRole(caller, 'TRADER');
    plainAmount(input.maxBaseAmount, false);
    plainAmount(input.maxQuoteAmount, false);
    requireSlippage(input.slippageBps);
    const id = randomUUID();
    const quote = await this.ledger.quoteDeposit(id, caller, accessToken, input);
    if (
      quote.quoteId !== id ||
      quote.poolId !== input.poolId ||
      plainAmount(quote.maxBaseAmount, false) !== plainAmount(input.maxBaseAmount, false) ||
      plainAmount(quote.maxQuoteAmount, false) !== plainAmount(input.maxQuoteAmount, false)
    ) {
      throw new Error('Deposit quote differs from requested terms');
    }
    await this.store.saveDepositQuote(quote, caller);
    return quote;
  }

  async quoteWithdrawal(caller: Account, accessToken: string, input: WithdrawalQuoteInput): Promise<WithdrawalQuote> {
    requireRole(caller, 'TRADER');
    plainAmount(input.lpAmount, false);
    requireSlippage(input.slippageBps);
    const id = randomUUID();
    const quote = await this.ledger.quoteWithdrawal(id, caller, accessToken, input);
    if (
      quote.quoteId !== id ||
      quote.poolId !== input.poolId ||
      plainAmount(quote.lpAmount, false) !== plainAmount(input.lpAmount, false)
    ) {
      throw new Error('Withdrawal quote differs from requested terms');
    }
    await this.store.saveWithdrawalQuote(quote, caller);
    return quote;
  }

  async prepareDeposit(caller: Account, accessToken: string, input: PrepareDepositInput): Promise<Preparation> {
    requireRole(caller, 'TRADER');
    const quote = await this.store.depositQuote(input.quoteId, caller);
    requireMinimum(input.minLpOut, quote.expectedLpOut);
    if (plainAmount(input.minRatio, false) > plainAmount(input.maxRatio, false)) {
      throw new InvalidRequest('Minimum ratio exceeds maximum ratio');
    }
    const settlementDeadline = approvedDeadline(input.settlementDeadline, quote.settlementDeadline);
    const terms: DepositTerms = {
      poolId: quote.poolId,
      poolName: quote.poolName,
      trader: quote.trader,
      baseInstrument: quote.baseInstrument,
      quoteInstrument: quote.quoteInstrument,
      lpInstrument: quote.lpInstrument,
      mode: quote.mode,
      maxBaseAmount: quote.maxBaseAmount,
      maxQuoteAmount: quote.maxQuoteAmount,
      expectedBaseAmount: quote.expectedBaseAmount,
      expectedQuoteAmount: quote.expectedQuoteAmount,
      expectedBaseRefund: quote.expectedBaseRefund,
      expectedQuoteRefund: quote.expectedQuoteRefund,
      expectedLpOut: quote.expectedLpOut,
      minLpOut: canonical(input.minLpOut),
      minRatio: canonical(input.minRatio),
      maxRatio: canonical(input.maxRatio),
      initialMinimumLp: quote.initialMinimumLp,
      settlementDeadline,
    };
    return this.prepare(caller, accessToken, input.quoteId, quote.quoteExpiresAt, terms);
  }

  async prepareWithdrawal(caller: Account, accessToken: string, input: PrepareWithdrawalInput): Promise<Preparation> {
    requireRole(caller, 'TRADER');
    const quote = await this.store.withdrawalQuote(input.quoteId, caller);
    requireMinimum(input.minBaseOut, quote.expectedBaseOut);
    requireMinimum(input.minQuoteOut, quote.expectedQuoteOut);
    const settlementDeadline = approvedDeadline(input.settlementDeadline, quote.settlementDeadline);
    const terms: WithdrawalTerms = {
      poolId: quote.poolId,
      poolName: quote.poolName,
      trader: quote.trader,
      baseInstrument: quote.baseInstrument,
      quoteInstrument: quote.quoteInstrument,
      lpInstrument: quote.lpInstrument,
      lpAmount: quote.lpAmount,
      expectedBaseOut: quote.expectedBaseOut,
      expectedQuoteOut: quote.expectedQuoteOut,
      minBaseOut: canonical(input.minBaseOut),
      minQuoteOut: canonical(input.minQuoteOut),
      settlementDeadline,
    };
    return this.prepare(caller, accessToken, input.quoteId, quote.quoteExpiresAt, terms);
  }

  private async prepare(
    caller: Account,
    accessToken: string,
    quoteId: string,
    quoteExpiresAt: string,
    terms: Terms,
  ): Promise<Preparation> {
    const previous = await this.store.preparedQuote(quoteId, caller);
    if (previous) {
      requireSameTerms(previous.request.terms, terms);
      if (epochNanos(previous.signing.expiresAt) <= this.clock()) {
        throw new Conflict('Check this request before requesting a new quote', 'PREPARATION_EXPIRED');
      }
      await this.ledger.requireAccess(caller, terms.poolId);
      return preparation(previous);
    }
    const now = this.clock();
    if (epochNanos(quoteExpiresAt) <= now) throw new Conflict('Request a new quote', 'QUOTE_EXPIRED');
    if (epochNanos(terms.settlementDeadline) <= now) {
      throw new Conflict('The settlement deadline has elapsed', 'DEADLINE_ELAPSED');
    }
    const requestId = randomUUID();
    const preparationId = randomUUID();
    const signing = await this.ledger.prepare(requestId, requestId, caller, accessToken, terms);
    requireSignable(signing, terms.trader, this.clock());
    if (signing.recoveryEffects.length > 0) throw new Error('Request preparation contains recovery effects');
    const stored = await this.store.savePreparation(
      requestId,
      preparationId,
      requestId,
      quoteId,
      caller,
      terms,
      signing,
    );
    requireSameTerms(stored.request.terms, terms);
    return preparation(stored);
  }

  async submit(kind: Kind, caller: Account, accessToken: string, input: Submission): Promise<Request> {
    requireRole(caller, 'TRADER');
    const pending = await this.store.pendingOwned(input.preparationId, caller);
    requireKind(pending.request, kind);
    if (pending.action !== 'SUBMIT') {
      throw new Conflict('This preparation recovers an expired request', 'PREPARATION_MISMATCH');
    }
    return this.execute(caller, accessToken, input, pending);
  }

  async get(id: string, kind: Kind, caller: Account): Promise<Request> {
    requireRole(caller, 'TRADER');
    return requireKind(await this.store.owned(id, caller), kind);
  }

  async activity(
    caller: Account,
    kind: Kind,
    limit: number,
    cursor: string | null,
    status: string | null,
  ): Promise<Activity> {
    requireRole(caller, 'TRADER');
    return this.store.activity(caller, kind, limit, cursor, status);
  }

  async positions(caller: Account, accessToken: string): Promise<Positions> {
    requireRole(caller, 'TRADER');
    return this.ledger.positions(caller, accessToken);
  }

  async prepareRecovery(id: string, kind: Kind, caller: Account, accessToken: string): Promise<Preparation> {
    const request = await this.get(id, kind, caller);
    if (request.status === 'SETTLED') throw new Conflict('The request has already settled', 'RECOVERY_UNAVAILABLE');
    const previous = await this.store.latestRecovery(id, caller);
    if (previous && (previous.signature !== null || epochNanos(previous.signing.expiresAt) > this.clock())) {
      await this.ledger.requireAccess(caller, request.terms.poolId);
      return preparation(previous);
    }
    if (epochNanos(request.terms.settlementDeadline) > this.clock()) {
      throw new Conflict('Recovery is available after the settlement deadline', 'DEADLINE_NOT_ELAPSED');
    }
    if (!request.canRecover) {
      throw new Conflict('No confirmed unsettled allocations can be recovered', 'RECOVERY_UNAVAILABLE');
    }
    const command = randomUUID();
    const preparationId = randomUUID();
    const signing = await this.ledger.prepareRecovery(command, request, caller, accessToken);
    requireSignable(signing, request.terms.trader, this.clock());
    if (signing.recoveryEffects.length === 0) {
      throw new Conflict('No active allocations remain; refresh the request', 'RECOVERY_UNAVAILABLE');
    }
    return preparation(await this.store.saveRecovery(id, preparationId, command, caller, signing, this.clock()));
  }

  async recover(id: string, kind: Kind, caller: Account, accessToken: string, input: Submission): Promise<Request> {
    requireRole(caller, 'TRADER');
    const pending = await this.store.pendingOwned(input.preparationId, caller);
    requireKind(pending.request, kind);
    if (pending.action !== 'RECOVER' || pending.request.requestId !== id) {
      throw new Conflict('This preparation does not recover the selected request', 'PREPARATION_MISMATCH');
    }
    return this.execute(caller, accessToken, input, pending);
  }

  private async execute(caller: Account, accessToken: string, input: Submission, pending: Pending): Promise<Request> {
    requireSignatureEncoding(input.signature);
    if (pending.signature !== null) {
      if (pending.signature !== input.signature) {
        throw new Conflict('This preparation already has a different signature', 'IDEMPOTENCY_CONFLICT');
      }
      return this.store.owned(pending.request.requestId, caller);
    }
    await this.ledger.verify(pending.signing, input.signature, caller);
    await this.ledger.requireAccess(caller, pending.request.terms.poolId);
    // The dispatch decision is durable first; uncertain outcomes are reconciled, never resent.
    const offset = await this.ledger.offset();
    if (await this.store.begin(input.preparationId, caller, input.signature, offset, this.clock())) {
      const claimed = await this.store.pendingOwned(input.preparationId, caller);
      try {
        const confirmation =
          claimed.action === 'SUBMIT'
            ? await this.ledger.submit(claimed, caller, accessToken)
            : await this.ledger.executeRecovery(claimed, caller, accessToken);
        await this.store.confirm(input.preparationId, confirmation);
      } catch (error) {
        if (error instanceof LiquidityRejected) {
          await this.store.rejected(input.preparationId, error);
        } else {
          await this.store.uncertain(input.preparationId);
          this.log.warn(
            { err: error, request: claimed.request.requestId, command: claimed.commandId },
            'Liquidity command awaits confirmation',
          );
        }
      }
    }
    return this.store.owned(pending.request.requestId, caller);
  }

  /** Recovers unknown submissions, then observes settlement or recovery of confirmed requests. */
  async reconcile(): Promise<void> {
    for (const pending of await this.store.unresolved()) {
      try {
        const confirmation = await this.ledger.recover(pending);
        if (confirmation) await this.store.confirm(pending.preparationId, confirmation);
      } catch (error) {
        if (error instanceof LiquidityRejected) await this.store.rejected(pending.preparationId, error);
        else this.log.warn({ err: error, request: pending.request.requestId }, 'Liquidity reconciliation failed');
      }
    }
    for (const pending of await this.store.tracked()) {
      try {
        const confirmation = await this.ledger.observe(pending);
        if (!confirmation) continue;
        if (confirmation.status !== 'SETTLED' && confirmation.status !== 'RECOVERED') {
          throw new Error('Non-terminal liquidity completion evidence');
        }
        await this.store.confirm(pending.preparationId, confirmation);
      } catch (error) {
        this.log.warn({ err: error, request: pending.request.requestId }, 'Liquidity observation failed');
      }
    }
  }
}
