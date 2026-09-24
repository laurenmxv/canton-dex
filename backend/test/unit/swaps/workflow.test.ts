import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import { numericUnits, plainText } from '../../../src/platform/decimal.js';
import { AccessDenied, Conflict, InvalidRequest, NotFound } from '../../../src/platform/errors.js';
import { epochNanos, instantText } from '../../../src/platform/time.js';
import type {
  Activity,
  Confirmation,
  Pending,
  Preparation,
  PrepareInput,
  Quote,
  QuoteInput,
  SigningPayload,
  Submission,
  Swap,
  SwapStatus,
  Terms,
} from '../../../src/swaps/model.js';
import { SwapRejected, type SwapLedger, type SwapProgress } from '../../../src/swaps/ports.js';
import { SwapWorkflow } from '../../../src/swaps/workflow.js';

const NOW = epochNanos('2026-09-19T12:00:00Z');
const SECOND = 1_000_000_000n;
const PARTY = 'alice::namespace';
const TOKEN = 'alice-access-token';
const SIGNATURE = Buffer.alloc(64).toString('base64');
const SILENT_LOG = { warn: () => undefined };

function account(subject: string, role: Account['role']): Account {
  return { id: randomUUID(), issuer: 'issuer', subject, displayName: subject, role };
}

class MutableClock {
  now = NOW;
  readonly read = () => this.now;
}

class Ledger implements SwapLedger {
  signingParty = PARTY;
  feeOverride: string | undefined;
  expectedOut = '100';
  minOut = '99';
  accessRevoked = false;
  failure: Error | undefined;
  verificationFailure: Error | undefined;
  recoveryFailure: Error | undefined;
  evidence: Confirmation | undefined;
  observation: Confirmation | undefined;
  offline = false;
  offsetReads = 0;
  quotes = 0;
  preparations = 0;
  submissions = 0;
  withdrawalPreparations = 0;
  withdrawals = 0;
  submitted: Pending | undefined;
  recovered: Pending | undefined;
  caller: Account | undefined;
  token: string | undefined;

  constructor(private readonly clock: MutableClock) {}

  requireAccess(): Promise<void> {
    if (this.accessRevoked)
      return Promise.reject(new Conflict('Current pool access is required', 'POOL_ACCESS_REQUIRED'));
    return Promise.resolve();
  }

  offset(): Promise<bigint> {
    this.offsetReads += 1;
    if (this.offline) return Promise.reject(new Error('participant offline'));
    return Promise.resolve(42n);
  }

  quote(id: string, _caller: Account, _token: string, input: QuoteInput): Promise<Quote> {
    this.quotes += 1;
    return Promise.resolve({
      quoteId: id,
      poolId: input.poolId,
      poolName: 'BTC/USDC',
      trader: PARTY,
      direction: input.direction,
      inputInstrument: { admin: 'issuer', id: 'BTC' },
      outputInstrument: { admin: 'issuer', id: 'USDC' },
      amountIn: input.amountIn,
      expectedOut: this.expectedOut,
      feeAmount: this.feeOverride ?? plainText(numericUnits(input.amountIn) * 3n, 13),
      minOut: this.minOut,
      slippageBps: input.slippageBps,
      stateId: 'pool-state',
      quoteExpiresAt: instantText(this.clock.now + 30n * SECOND),
      settlementDeadline: instantText(this.clock.now + 120n * SECOND),
    });
  }

  prepare(): Promise<SigningPayload> {
    this.preparations += 1;
    return Promise.resolve(this.signing());
  }

  submit(pending: Pending, caller: Account, token: string): Promise<Confirmation> {
    this.submissions += 1;
    this.submitted = pending;
    this.caller = caller;
    this.token = token;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.confirmation('READY'));
  }

  verify(): Promise<void> {
    return this.verificationFailure ? Promise.reject(this.verificationFailure) : Promise.resolve();
  }

  recover(pending: Pending): Promise<Confirmation | undefined> {
    this.recovered = pending;
    if (this.recoveryFailure) return Promise.reject(this.recoveryFailure);
    return Promise.resolve(this.evidence);
  }

  observe(): Promise<Confirmation | undefined> {
    return Promise.resolve(this.observation);
  }

  prepareWithdrawal(): Promise<SigningPayload> {
    this.withdrawalPreparations += 1;
    return Promise.resolve(this.signing());
  }

  withdraw(): Promise<Confirmation> {
    this.withdrawals += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.confirmation('WITHDRAWN'));
  }

  signing(): SigningPayload {
    return {
      preparedTransaction: 'opaque-prepared-transaction',
      preparedTransactionHash: Buffer.alloc(32).toString('base64'),
      hashingSchemeVersion: 2,
      partyId: this.signingParty,
      publicKeyFingerprint: 'alice-key',
      expiresAt: instantText(this.clock.now + 20n * SECOND),
    };
  }

  confirmation(status: SwapStatus): Confirmation {
    return {
      status,
      allocationCids: ['input-allocation', 'output-allocation'],
      amountOut: null,
      updateId: `update-${status}`,
      offset: 43n,
      confirmedAt: instantText(this.clock.now),
    };
  }
}

/** An in-memory swap store with the baseline double's transitions. */
class Progress implements SwapProgress {
  readonly quotes = new Map<string, Quote>();
  readonly quoteOwners = new Map<string, string>();
  readonly preparations = new Map<string, Pending>();
  readonly swaps = new Map<string, Swap>();
  readonly owners = new Map<string, string>();
  readonly attempted = new Set<string>();
  readonly awaitingEvidence = new Set<string>();
  readonly confirmed = new Set<string>();
  readonly failed = new Set<string>();

  constructor(private readonly clock: MutableClock) {}

  saveQuote(quote: Quote, caller: Account): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
    this.quoteOwners.set(quote.quoteId, caller.id);
    return Promise.resolve();
  }

  quote(id: string, caller: Account): Promise<Quote> {
    const quote = this.quotes.get(id);
    if (this.quoteOwners.get(id) !== caller.id || !quote) return Promise.reject(new NotFound());
    return Promise.resolve(quote);
  }

  async preparedQuote(quoteId: string, caller: Account): Promise<Pending | undefined> {
    const found = [...this.preparations.values()].find(
      (p) => p.action === 'SUBMIT' && p.accountId === caller.id && p.swap.quoteId === quoteId,
    );
    return found ? this.pendingOwned(found.preparationId, caller) : undefined;
  }

  savePreparation(
    id: string,
    preparation: string,
    command: string,
    quoteId: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending> {
    const at = instantText(this.clock.now);
    const swap: Swap = {
      swapId: id,
      quoteId,
      ...terms,
      status: 'PREPARED',
      arrivalSequence: null,
      createdAt: at,
      submittedAt: null,
      updatedAt: at,
      settlementId: null,
      amountOut: null,
      allocationCids: [],
      updateId: null,
      errorCode: null,
      error: null,
      canWithdraw: false,
    };
    this.swaps.set(id, swap);
    this.owners.set(id, caller.id);
    const pending: Pending = {
      swap,
      accountId: caller.id,
      preparationId: preparation,
      commandId: command,
      action: 'SUBMIT',
      signing,
      signature: null,
      beginOffset: 0n,
    };
    this.preparations.set(preparation, pending);
    return Promise.resolve(pending);
  }

  owned(id: string, caller: Account): Promise<Swap> {
    if (this.owners.get(id) !== caller.id) return Promise.reject(new NotFound());
    return Promise.resolve(this.get(id));
  }

  get(id: string): Swap {
    const swap = this.swaps.get(id);
    if (!swap) throw new NotFound();
    const canWithdraw =
      swap.allocationCids.length > 0 &&
      epochNanos(swap.settlementDeadline) <= this.clock.now &&
      !['SETTLED', 'WITHDRAWN', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED'].includes(swap.status);
    return this.copy(swap, swap.status, swap.errorCode, swap.error, canWithdraw);
  }

  async pendingOwned(id: string, caller: Account): Promise<Pending> {
    const pending = this.preparations.get(id);
    if (!pending || pending.accountId !== caller.id) throw new NotFound();
    return { ...pending, swap: await this.owned(pending.swap.swapId, caller) };
  }

  async begin(id: string, caller: Account, signature: string, offset: bigint): Promise<boolean> {
    const pending = await this.pendingOwned(id, caller);
    if (pending.signature !== null && pending.signature !== signature) {
      throw new Conflict('Different signature', 'IDEMPOTENCY_CONFLICT');
    }
    if (this.attempted.has(id)) return false;
    this.attempted.add(id);
    this.preparations.set(id, { ...pending, signature, beginOffset: offset });
    this.awaitingEvidence.add(id);
    this.phase(id, pending.action === 'SUBMIT' ? 'SUBMITTING' : 'WITHDRAWING', null, null);
    return true;
  }

  confirm(id: string, confirmation: Confirmation): Promise<void> {
    const pending = this.preparation(id);
    const swap = this.get(pending.swap.swapId);
    this.swaps.set(swap.swapId, {
      ...swap,
      status: confirmation.status,
      updatedAt: confirmation.confirmedAt,
      amountOut: confirmation.amountOut,
      allocationCids: confirmation.allocationCids,
      updateId: confirmation.updateId,
      errorCode: null,
      error: null,
      canWithdraw: false,
    });
    this.awaitingEvidence.delete(id);
    this.confirmed.add(id);
    return Promise.resolve();
  }

  uncertain(id: string): Promise<void> {
    const submit = this.preparation(id).action === 'SUBMIT';
    this.phase(
      id,
      submit ? 'UNRESOLVED' : 'WITHDRAWAL_UNRESOLVED',
      'CONFIRMATION_PENDING',
      'Waiting for ledger confirmation',
    );
    return Promise.resolve();
  }

  rejected(id: string, failure: SwapRejected): Promise<void> {
    this.phase(id, this.preparation(id).action === 'SUBMIT' ? 'FAILED' : 'EXPIRED', failure.code, failure.message);
    this.awaitingEvidence.delete(id);
    this.failed.add(id);
    return Promise.resolve();
  }

  unresolved(): Promise<Pending[]> {
    return Promise.resolve([...this.awaitingEvidence].map((id) => this.preparation(id)));
  }

  tracked(): Promise<Pending[]> {
    return Promise.resolve(
      [...this.confirmed]
        .map((id) => this.preparation(id))
        .filter((p) => p.action === 'SUBMIT' && !['SETTLED', 'WITHDRAWN'].includes(this.get(p.swap.swapId).status))
        .map((p) => ({ ...p, swap: this.get(p.swap.swapId) })),
    );
  }

  async latestWithdrawal(id: string, caller: Account): Promise<Pending | undefined> {
    await this.owned(id, caller);
    const last = [...this.preparations.values()]
      .filter((p) => p.swap.swapId === id && p.action === 'WITHDRAW' && !this.failed.has(p.preparationId))
      .at(-1);
    return last ? this.pendingOwned(last.preparationId, caller) : undefined;
  }

  async saveWithdrawal(
    id: string,
    preparation: string,
    command: string,
    caller: Account,
    signing: SigningPayload,
  ): Promise<Pending> {
    const pending: Pending = {
      swap: await this.owned(id, caller),
      accountId: caller.id,
      preparationId: preparation,
      commandId: command,
      action: 'WITHDRAW',
      signing,
      signature: null,
      beginOffset: 0n,
    };
    this.preparations.set(preparation, pending);
    return pending;
  }

  activity(): Promise<Activity> {
    return Promise.reject(new Error('Not used by the workflow tests'));
  }

  private preparation(id: string): Pending {
    const pending = this.preparations.get(id);
    if (!pending) throw new NotFound();
    return pending;
  }

  private phase(id: string, status: SwapStatus, code: string | null, error: string | null): void {
    const swap = this.get(this.preparation(id).swap.swapId);
    this.swaps.set(swap.swapId, this.copy(swap, status, code, error, false));
  }

  private copy(swap: Swap, status: SwapStatus, code: string | null, error: string | null, canWithdraw: boolean): Swap {
    return { ...swap, status, updatedAt: instantText(this.clock.now), errorCode: code, error, canWithdraw };
  }
}

async function failure(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  const error = await failure(run);
  return error instanceof Conflict ? error.code : undefined;
}

describe('swap workflow', () => {
  const trader = account('alice', 'TRADER');
  const otherTrader = account('bob', 'TRADER');
  let clock: MutableClock;
  let store: Progress;
  let ledger: Ledger;
  let workflow: SwapWorkflow;

  beforeEach(() => {
    clock = new MutableClock();
    store = new Progress(clock);
    ledger = new Ledger(clock);
    workflow = new SwapWorkflow(store, ledger, SILENT_LOG, clock.read);
  });

  function input(amount: string): QuoteInput {
    return { poolId: 'pool', direction: 'BaseToQuote', amountIn: amount, slippageBps: 100 };
  }

  function quote(amount: string): Promise<Quote> {
    return workflow.quote(trader, TOKEN, input(amount));
  }

  function approved(value: Quote): PrepareInput {
    return { quoteId: value.quoteId, minOut: value.minOut, settlementDeadline: epochNanos(value.settlementDeadline) };
  }

  function prepare(value: Quote): Promise<Preparation> {
    return workflow.prepare(trader, TOKEN, approved(value));
  }

  function signed(preparation: Preparation): Submission {
    return { preparationId: preparation.preparationId, signature: SIGNATURE };
  }

  function restarted(): SwapWorkflow {
    return new SwapWorkflow(store, ledger, SILENT_LOG, clock.read);
  }

  it('a signed submission uses the stored identity, terms and command', async () => {
    const value = await quote('10');
    const preparation = await prepare(value);
    const result = await workflow.submit(trader, TOKEN, signed(preparation));

    expect(result.status).toBe('READY');
    expect(result.allocationCids).toEqual(['input-allocation', 'output-allocation']);
    expect(ledger.submitted?.swap.swapId).toBe(preparation.swapId);
    expect(ledger.submitted?.commandId).toBe(preparation.swapId);
    expect(ledger.submitted?.preparationId).toBe(preparation.preparationId);
    expect(ledger.submitted?.accountId).toBe(trader.id);
    expect(ledger.submitted?.signature).toBe(SIGNATURE);
    expect(ledger.submitted?.beginOffset).toBe(42n);
    expect(ledger.submitted?.swap.minOut).toBe(value.minOut);
    expect(ledger.submitted?.swap.settlementDeadline).toBe(value.settlementDeadline);
    expect(ledger.submitted?.signing.partyId).toBe(PARTY);
    expect(ledger.caller).toEqual(trader);
    expect(ledger.token).toBe(TOKEN);
  });

  it('another account cannot prepare, submit or read the swap', async () => {
    const value = await quote('10');
    await expect(workflow.prepare(otherTrader, 'other-token', approved(value))).rejects.toThrow(NotFound);
    const preparation = await prepare(value);
    await expect(workflow.submit(otherTrader, 'other-token', signed(preparation))).rejects.toThrow(NotFound);
    await expect(workflow.get(preparation.swapId, otherTrader)).rejects.toThrow(NotFound);
    expect(ledger.submissions).toBe(0);
  });

  it('the operator role cannot use trader operations', async () => {
    const operator = account('operator', 'OPERATOR');
    await expect(workflow.quote(operator, 'operator-token', input('10'))).rejects.toThrow(AccessDenied);
    expect(ledger.quotes).toBe(0);
  });

  it('the action and swap identity cannot be changed at submission', async () => {
    const preparation = await prepare(await quote('10'));
    expect(await code(workflow.withdraw(preparation.swapId, trader, TOKEN, signed(preparation)))).toBe(
      'PREPARATION_MISMATCH',
    );
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const withdrawal = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);

    expect(await code(workflow.submit(trader, TOKEN, signed(withdrawal)))).toBe('PREPARATION_MISMATCH');
    expect(await code(workflow.withdraw(randomUUID(), trader, TOKEN, signed(withdrawal)))).toBe('PREPARATION_MISMATCH');
    expect(ledger.withdrawals).toBe(0);
  });

  it('a lost response remains unknown until evidence and is never replayed', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.failure = new Error('response lost');
    expect((await workflow.submit(trader, TOKEN, signed(preparation))).status).toBe('UNRESOLVED');
    ledger.offline = true;
    expect((await workflow.submit(trader, TOKEN, signed(preparation))).status).toBe('UNRESOLVED');
    expect(ledger.offsetReads).toBe(1);

    const recovered = restarted();
    await recovered.reconcile();
    expect((await recovered.get(preparation.swapId, trader)).status).toBe('UNRESOLVED');
    expect(ledger.submissions).toBe(1);

    ledger.evidence = ledger.confirmation('READY');
    await recovered.reconcile();
    expect((await recovered.get(preparation.swapId, trader)).status).toBe('READY');
    expect((await recovered.submit(trader, TOKEN, signed(preparation))).status).toBe('READY');
    expect(ledger.submissions).toBe(1);
    expect(ledger.recovered?.commandId).toBe(preparation.swapId);
    expect(ledger.recovered?.beginOffset).toBe(42n);
  });

  it('the signature cannot be replaced after an unknown submission', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.failure = new Error('response lost');
    await workflow.submit(trader, TOKEN, signed(preparation));
    const replacement = Buffer.alloc(64, 1).toString('base64');
    expect(
      await code(workflow.submit(trader, TOKEN, { preparationId: preparation.preparationId, signature: replacement })),
    ).toBe('IDEMPOTENCY_CONFLICT');
    expect(ledger.submissions).toBe(1);
    expect(ledger.offsetReads).toBe(1);
  });

  it('a definitive rejection recovered after a lost response ends the unknown state', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.failure = new Error('response lost');
    await workflow.submit(trader, TOKEN, signed(preparation));
    ledger.recoveryFailure = new SwapRejected('CONTRACT_NOT_ACTIVE', 'Allocation input consumed');
    await restarted().reconcile();
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('FAILED');
    expect((await workflow.get(preparation.swapId, trader)).errorCode).toBe('CONTRACT_NOT_ACTIVE');
    expect(ledger.submissions).toBe(1);
    expect(await store.unresolved()).toEqual([]);
  });

  it('a malformed signature does not claim or send the preparation', async () => {
    const preparation = await prepare(await quote('10'));
    for (const signature of ['not base64!', '', Buffer.alloc(145).toString('base64')]) {
      await expect(
        workflow.submit(trader, TOKEN, { preparationId: preparation.preparationId, signature }),
      ).rejects.toThrow(InvalidRequest);
    }
    expect(store.attempted.size).toBe(0);
    expect(ledger.submissions).toBe(0);
    expect((await workflow.submit(trader, TOKEN, signed(preparation))).status).toBe('READY');
  });

  it('a locally invalid wallet signature never claims the preparation or enters the queue', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.verificationFailure = new InvalidRequest('Signature does not match the registered wallet');
    await expect(workflow.submit(trader, TOKEN, signed(preparation))).rejects.toThrow(InvalidRequest);
    expect(store.attempted.size).toBe(0);
    expect(ledger.submissions).toBe(0);
    expect(ledger.offsetReads).toBe(0);
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('PREPARED');
    ledger.verificationFailure = undefined;
    expect((await workflow.submit(trader, TOKEN, signed(preparation))).status).toBe('READY');
  });

  it('a definitive submission rejection is failed and not replayed', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.failure = new SwapRejected('INVALID_SIGNATURE', 'Signature was rejected');
    const result = await workflow.submit(trader, TOKEN, signed(preparation));
    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_SIGNATURE');
    await workflow.submit(trader, TOKEN, signed(preparation));
    await workflow.reconcile();
    expect(ledger.submissions).toBe(1);
    expect(await store.unresolved()).toEqual([]);
  });

  it('the same quote cannot be prepared with a different minimum or deadline', async () => {
    const value = await quote('10');
    const deadline = epochNanos(value.settlementDeadline);
    const first = await workflow.prepare(trader, TOKEN, {
      quoteId: value.quoteId,
      minOut: '90',
      settlementDeadline: deadline,
    });
    const same = await workflow.prepare(trader, TOKEN, {
      quoteId: value.quoteId,
      minOut: '90.0',
      settlementDeadline: deadline,
    });
    expect(same).toEqual(first);
    for (const changed of [
      { quoteId: value.quoteId, minOut: '89', settlementDeadline: deadline },
      { quoteId: value.quoteId, minOut: '90', settlementDeadline: deadline - SECOND },
    ]) {
      expect(await code(workflow.prepare(trader, TOKEN, changed))).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(ledger.preparations).toBe(1);
  });

  it('revocation blocks cached preparations and dispatch without hiding progress', async () => {
    const value = await quote('10');
    const preparation = await prepare(value);
    ledger.accessRevoked = true;
    expect(await code(prepare(value))).toBe('POOL_ACCESS_REQUIRED');
    expect(await code(workflow.submit(trader, TOKEN, signed(preparation)))).toBe('POOL_ACCESS_REQUIRED');
    expect(store.attempted.size).toBe(0);
    expect(ledger.submissions).toBe(0);
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('PREPARED');
    ledger.accessRevoked = false;
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const withdrawal = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    ledger.accessRevoked = true;
    expect(await code(workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN))).toBe('POOL_ACCESS_REQUIRED');
    expect(await code(workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal)))).toBe(
      'POOL_ACCESS_REQUIRED',
    );
    expect([...store.attempted]).toEqual([preparation.preparationId]);
    expect(ledger.withdrawals).toBe(0);
    expect((await workflow.submit(trader, TOKEN, signed(preparation))).status).toBe('READY');
  });

  it('a quote accepts native decimal amounts above one million', async () => {
    for (const valid of ['1000000.0000000001', '9999999999999999999999999999.9999999999', '0.0000000001']) {
      expect((await quote(valid)).amountIn).toBe(valid);
    }
    for (const invalid of ['0', '-1', '10000000000000000000000000000', '0.00000000001', '1e3', '01', '1 ']) {
      await expect(quote(invalid), invalid).rejects.toThrow(InvalidRequest);
    }
    expect(ledger.quotes).toBe(3);
  });

  it('prepares the quoted input, output, minimum and fee above one million', async () => {
    ledger.expectedOut = '24000000000';
    ledger.minOut = '23000000000';
    const preparation = await prepare(await quote('30000000000'));
    expect(preparation.terms.amountIn).toBe('30000000000');
    expect(preparation.terms.expectedOut).toBe('24000000000');
    expect(preparation.terms.minOut).toBe('23000000000');
    expect(preparation.terms.feeAmount).toBe('90000000');
  });

  it('prepare rejects an unsupported minimum and deadline', async () => {
    const value = await quote('10');
    const deadline = epochNanos(value.settlementDeadline);
    for (const invalid of ['10000000000000000000000000000', '0.00000000001', '100.0000000001', '-1']) {
      await expect(
        workflow.prepare(trader, TOKEN, { quoteId: value.quoteId, minOut: invalid, settlementDeadline: deadline }),
        invalid,
      ).rejects.toThrow(InvalidRequest);
    }
    await expect(
      workflow.prepare(trader, TOKEN, { quoteId: value.quoteId, minOut: '90', settlementDeadline: deadline + SECOND }),
    ).rejects.toThrow(InvalidRequest);
    expect(ledger.preparations).toBe(0);
  });

  it('a submicrosecond deadline is rejected before preparing or saving', async () => {
    const value = await quote('10');
    for (const nanos of [1n, 999n, 1001n]) {
      const deadline = epochNanos(value.settlementDeadline) - SECOND + nanos;
      await expect(
        workflow.prepare(trader, TOKEN, { quoteId: value.quoteId, minOut: value.minOut, settlementDeadline: deadline }),
        String(deadline),
      ).rejects.toThrow(InvalidRequest);
    }
    expect(ledger.preparations).toBe(0);
    expect(store.preparations.size).toBe(0);
    expect(store.swaps.size).toBe(0);
  });

  it('a microsecond deadline is preserved in the prepared terms and the stored swap', async () => {
    for (const nanos of [1_000n, 123_456_000n]) {
      const value = await quote('10');
      const deadline = epochNanos(value.settlementDeadline) - SECOND + nanos;
      const preparation = await workflow.prepare(trader, TOKEN, {
        quoteId: value.quoteId,
        minOut: value.minOut,
        settlementDeadline: deadline,
      });
      expect(epochNanos(preparation.terms.settlementDeadline)).toBe(deadline);
      expect(epochNanos((await workflow.get(preparation.swapId, trader)).settlementDeadline)).toBe(deadline);
    }
    expect(ledger.preparations).toBe(2);
    expect(store.preparations.size).toBe(2);
  });

  it('the informational fee retains exact bps precision for one satoshi', async () => {
    expect((await quote('0.00000001')).feeAmount).toBe('0.00000000003');
    for (const invalid of ['0.000000000000003', '0.00000001001']) {
      ledger.feeOverride = invalid;
      await expect(quote('0.00000001'), invalid).rejects.toThrow(InvalidRequest);
    }
  });

  it('an expired quote and an elapsed settlement deadline cannot be prepared', async () => {
    const value = await quote('10');
    expect(
      await code(workflow.prepare(trader, TOKEN, { quoteId: value.quoteId, minOut: '90', settlementDeadline: NOW })),
    ).toBe('DEADLINE_ELAPSED');
    clock.now = epochNanos(value.quoteExpiresAt);
    expect(await code(prepare(value))).toBe('QUOTE_EXPIRED');
    expect(ledger.preparations).toBe(0);
  });

  it('a signing payload for another party cannot be persisted', async () => {
    ledger.signingParty = 'bob::namespace';
    const error = await failure(prepare(await quote('10')));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(InvalidRequest);
    expect(store.preparations.size).toBe(0);
  });

  it('an expired preparation cannot be offered for signing again', async () => {
    const value = await quote('10');
    const preparation = await prepare(value);
    clock.now = epochNanos(preparation.expiresAt);
    expect(await code(prepare(value))).toBe('PREPARATION_EXPIRED');
    expect(ledger.preparations).toBe(1);
    expect(ledger.submissions).toBe(0);
    expect(store.preparations.size).toBe(1);
  });

  it('an expired preparation does not replace or close an unknown submission', async () => {
    const value = await quote('10');
    const preparation = await prepare(value);
    ledger.failure = new Error('response lost');
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.expiresAt);

    expect(await code(prepare(value))).toBe('PREPARATION_EXPIRED');
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('UNRESOLVED');
    ledger.evidence = ledger.confirmation('READY');
    await workflow.reconcile();
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('READY');
    expect(ledger.preparations).toBe(1);
    expect(ledger.submissions).toBe(1);
    expect(store.preparations.size).toBe(1);
  });

  it('a withdrawal requires the deadline and confirmed allocations', async () => {
    const preparation = await prepare(await quote('10'));
    await workflow.submit(trader, TOKEN, signed(preparation));
    expect(await code(workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN))).toBe('DEADLINE_NOT_ELAPSED');
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const withdrawal = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    expect(withdrawal.action).toBe('WITHDRAW');
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('READY');
    expect((await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal))).status).toBe('WITHDRAWN');
    expect((await workflow.get(preparation.swapId, trader)).canWithdraw).toBe(false);
  });

  it('a late settlement invalidates an unsigned withdrawal preparation', async () => {
    const preparation = await prepare(await quote('10'));
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    ledger.observation = ledger.confirmation('SETTLED');
    await workflow.reconcile();
    expect(await code(workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN))).toBe('WITHDRAWAL_UNAVAILABLE');
    expect(ledger.withdrawals).toBe(0);
  });

  it('an elapsed deadline without confirmed allocations cannot release funds', async () => {
    const preparation = await prepare(await quote('10'));
    ledger.failure = new Error('response lost');
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    expect(await code(workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN))).toBe('WITHDRAWAL_UNAVAILABLE');
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('UNRESOLVED');
    expect(ledger.withdrawalPreparations).toBe(0);
  });

  it('a rejected withdrawal keeps the confirmed allocations and the expired state', async () => {
    const preparation = await prepare(await quote('10'));
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const withdrawal = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    ledger.failure = new SwapRejected('WITHDRAW_REJECTED', 'Withdrawal rejected');
    const result = await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal));
    expect(result.status).toBe('EXPIRED');
    expect(result.allocationCids).toEqual(['input-allocation', 'output-allocation']);
    expect(result.canWithdraw).toBe(true);
    expect(result.errorCode).toBe('WITHDRAW_REJECTED');
    await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal));
    expect(ledger.withdrawals).toBe(1);
    const retry = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    expect(retry.preparationId).not.toBe(withdrawal.preparationId);
    ledger.failure = undefined;
    expect((await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(retry))).status).toBe('WITHDRAWN');
    expect(ledger.withdrawals).toBe(2);
  });

  it('a lost withdrawal response is not reported as released or replayed', async () => {
    const preparation = await prepare(await quote('10'));
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const withdrawal = await workflow.prepareWithdrawal(preparation.swapId, trader, TOKEN);
    ledger.failure = new Error('response lost');
    expect((await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal))).status).toBe(
      'WITHDRAWAL_UNRESOLVED',
    );
    await workflow.withdraw(preparation.swapId, trader, TOKEN, signed(withdrawal));
    await workflow.reconcile();
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('WITHDRAWAL_UNRESOLVED');
    expect(ledger.withdrawals).toBe(1);

    ledger.evidence = ledger.confirmation('WITHDRAWN');
    await restarted().reconcile();
    expect((await workflow.get(preparation.swapId, trader)).status).toBe('WITHDRAWN');
    expect(ledger.withdrawals).toBe(1);
  });

  it('a wallet withdrawal while the backend was offline requires positive terminal evidence', async () => {
    const preparation = await prepare(await quote('10'));
    await workflow.submit(trader, TOKEN, signed(preparation));
    clock.now = epochNanos(preparation.terms.settlementDeadline);
    const recovered = restarted();
    await recovered.reconcile();
    expect((await recovered.get(preparation.swapId, trader)).status).toBe('READY');

    ledger.observation = ledger.confirmation('WITHDRAWN');
    await recovered.reconcile();
    expect((await recovered.get(preparation.swapId, trader)).status).toBe('WITHDRAWN');
    expect((await recovered.get(preparation.swapId, trader)).canWithdraw).toBe(false);
    expect(ledger.submissions).toBe(1);
    expect(ledger.withdrawals).toBe(0);
  });
});
