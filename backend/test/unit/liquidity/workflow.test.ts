import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import {
  kindOf,
  type Activity,
  type Confirmation,
  type DepositQuote,
  type DepositQuoteInput,
  type Kind,
  type LiquidityStatus,
  type Pending,
  type Positions,
  type Preparation,
  type RecoveryEffect,
  type Request,
  type Result,
  type SigningPayload,
  type Terms,
  type WithdrawalQuote,
  type WithdrawalQuoteInput,
} from '../../../src/liquidity/model.js';
import type { LiquidityLedger, LiquidityProgress } from '../../../src/liquidity/ports.js';
import { LiquidityWorkflow } from '../../../src/liquidity/workflow.js';
import { AccessDenied, Conflict, InvalidRequest, NotFound } from '../../../src/platform/errors.js';
import { jsonText } from '../../../src/platform/json.js';
import { epochNanos, instantText } from '../../../src/platform/time.js';
import type { Submission } from '../../../src/swaps/model.js';

const NOW = epochNanos('2026-09-22T12:00:00Z');
const SECOND = 1_000_000_000n;
const TRADER: Account = {
  id: randomUUID(),
  issuer: 'issuer',
  subject: 'trader',
  displayName: 'Trader',
  role: 'TRADER',
};
const BASE = { admin: 'issuer', id: 'BASE' };
const QUOTE = { admin: 'issuer', id: 'QUOTE' };
const LP = { admin: 'dvo', id: 'LP' };
const SIGNATURE = Buffer.alloc(64).toString('base64');
const SILENT_LOG = { warn: () => undefined };
const KINDS: readonly Kind[] = ['DEPOSIT', 'WITHDRAW'];

class TestClock {
  now = NOW;
  readonly read = () => this.now;
}

class Ledger implements LiquidityLedger {
  submissions = 0;
  preparations = 0;
  verifications = 0;
  recoveries = 0;
  badSignature = false;
  accessRevoked = false;
  failure: Error | undefined;
  evidence: Confirmation | undefined;
  observation: Confirmation | undefined;

  constructor(private readonly clock: TestClock) {}

  requireAccess(): Promise<void> {
    if (this.accessRevoked)
      return Promise.reject(new Conflict('Current pool access is required', 'POOL_ACCESS_REQUIRED'));
    return Promise.resolve();
  }

  offset(): Promise<bigint> {
    return Promise.resolve(42n);
  }

  quoteDeposit(id: string, _caller: Account, _token: string, input: DepositQuoteInput): Promise<DepositQuote> {
    return Promise.resolve({
      quoteId: id,
      poolId: 'pool',
      poolName: 'Pool',
      trader: 'trader',
      baseInstrument: BASE,
      quoteInstrument: QUOTE,
      lpInstrument: LP,
      mode: 'PROPORTIONAL',
      maxBaseAmount: input.maxBaseAmount,
      maxQuoteAmount: input.maxQuoteAmount,
      expectedBaseAmount: '10',
      expectedQuoteAmount: '20',
      expectedBaseRefund: '0',
      expectedQuoteRefund: '5',
      expectedLpOut: '10',
      minLpOut: '9.9',
      minRatio: '1.98',
      maxRatio: '2.02',
      initialMinimumLp: null,
      slippageBps: input.slippageBps,
      stateId: 'state',
      quoteExpiresAt: instantText(this.clock.now + 30n * SECOND),
      settlementDeadline: instantText(this.clock.now + 600n * SECOND),
    });
  }

  quoteWithdrawal(id: string, _caller: Account, _token: string, input: WithdrawalQuoteInput): Promise<WithdrawalQuote> {
    return Promise.resolve({
      quoteId: id,
      poolId: 'pool',
      poolName: 'Pool',
      trader: 'trader',
      baseInstrument: BASE,
      quoteInstrument: QUOTE,
      lpInstrument: LP,
      lpAmount: input.lpAmount,
      expectedBaseOut: '1',
      expectedQuoteOut: '2',
      minBaseOut: '0.99',
      minQuoteOut: '1.98',
      slippageBps: input.slippageBps,
      stateId: 'state',
      quoteExpiresAt: instantText(this.clock.now + 30n * SECOND),
      settlementDeadline: instantText(this.clock.now + 600n * SECOND),
    });
  }

  prepare(): Promise<SigningPayload> {
    this.preparations += 1;
    return Promise.resolve(this.signing([]));
  }

  verify(): Promise<void> {
    this.verifications += 1;
    if (this.badSignature) return Promise.reject(new InvalidRequest('Signature does not match the registered wallet'));
    return Promise.resolve();
  }

  submit(): Promise<Confirmation> {
    this.submissions += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.confirmation('READY'));
  }

  recover(): Promise<Confirmation | undefined> {
    return Promise.resolve(this.evidence);
  }

  observe(): Promise<Confirmation | undefined> {
    return Promise.resolve(this.observation);
  }

  prepareRecovery(): Promise<SigningPayload> {
    return Promise.resolve(
      this.signing([
        { allocationCid: 'lp', instrument: LP, amount: '1', kind: 'RETURN_FUNDS' },
        { allocationCid: 'quote', instrument: QUOTE, amount: '0', kind: 'RELEASE_PERMISSION' },
      ]),
    );
  }

  executeRecovery(): Promise<Confirmation> {
    this.recoveries += 1;
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(this.confirmation('RECOVERED'));
  }

  positions(): Promise<Positions> {
    return Promise.resolve({ items: [], asOfOffset: 42n });
  }

  private signing(recoveryEffects: RecoveryEffect[]): SigningPayload {
    return {
      preparedTransaction: 'opaque-transaction',
      preparedTransactionHash: Buffer.alloc(32).toString('base64'),
      hashingSchemeVersion: 3,
      partyId: 'trader',
      publicKeyFingerprint: 'key',
      expiresAt: instantText(this.clock.now + 45n * SECOND),
      recoveryEffects,
    };
  }

  confirmation(status: LiquidityStatus): Confirmation {
    return {
      status,
      allocationCids: ['base', 'quote', 'lp'],
      result: null,
      updateId: 'update',
      offset: 43n,
      confirmedAt: instantText(this.clock.now),
    };
  }
}

/** An in-memory liquidity store with the baseline double's transitions. */
class Progress implements LiquidityProgress {
  readonly quotes = new Map<string, DepositQuote | WithdrawalQuote>();
  readonly requests = new Map<string, Request>();
  readonly pending = new Map<string, Pending>();
  readonly confirmed = new Set<string>();

  constructor(private readonly clock: TestClock) {}

  saveDepositQuote(quote: DepositQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
    return Promise.resolve();
  }

  saveWithdrawalQuote(quote: WithdrawalQuote): Promise<void> {
    this.quotes.set(quote.quoteId, quote);
    return Promise.resolve();
  }

  depositQuote(id: string): Promise<DepositQuote> {
    const quote = this.quotes.get(id);
    if (!quote || !('mode' in quote)) return Promise.reject(new NotFound());
    return Promise.resolve(quote);
  }

  withdrawalQuote(id: string): Promise<WithdrawalQuote> {
    const quote = this.quotes.get(id);
    if (!quote || 'mode' in quote) return Promise.reject(new NotFound());
    return Promise.resolve(quote);
  }

  async preparedQuote(id: string, caller: Account): Promise<Pending | undefined> {
    const found = [...this.pending.values()].find((p) => p.action === 'SUBMIT' && p.request.quoteId === id);
    return found ? this.pendingOwned(found.preparationId, caller) : undefined;
  }

  savePreparation(
    id: string,
    preparation: string,
    command: string,
    quote: string,
    caller: Account,
    terms: Terms,
    signing: SigningPayload,
  ): Promise<Pending> {
    const at = instantText(this.clock.now);
    const request: Request = {
      requestId: id,
      quoteId: quote,
      kind: kindOf(terms),
      terms,
      status: 'PREPARED',
      arrivalSequence: null,
      createdAt: at,
      submittedAt: null,
      updatedAt: at,
      settlementId: null,
      result: null,
      allocationCids: [],
      updateId: null,
      errorCode: null,
      error: null,
      canRecover: false,
    };
    this.requests.set(id, request);
    const value: Pending = {
      request,
      accountId: caller.id,
      preparationId: preparation,
      commandId: command,
      action: 'SUBMIT',
      signing,
      signature: null,
      beginOffset: 0n,
    };
    this.pending.set(preparation, value);
    return Promise.resolve(value);
  }

  owned(id: string, caller: Account): Promise<Request> {
    const owns = [...this.pending.values()].some((p) => p.request.requestId === id && p.accountId === caller.id);
    return owns ? Promise.resolve(this.get(id)) : Promise.reject(new NotFound());
  }

  get(id: string): Request {
    const request = this.requests.get(id);
    if (!request) throw new NotFound();
    const canRecover =
      request.allocationCids.length > 0 &&
      epochNanos(request.terms.settlementDeadline) <= this.clock.now &&
      ['READY', 'BLOCKED', 'EXPIRED'].includes(request.status);
    return { ...request, canRecover };
  }

  async pendingOwned(id: string, caller: Account): Promise<Pending> {
    const found = this.pending.get(id);
    if (!found || found.accountId !== caller.id) throw new NotFound();
    return { ...found, request: await this.owned(found.request.requestId, caller) };
  }

  async begin(id: string, caller: Account, signature: string, offset: bigint): Promise<boolean> {
    const found = await this.pendingOwned(id, caller);
    if (found.signature !== null) return false;
    this.pending.set(id, { ...found, signature, beginOffset: offset });
    const status = found.action === 'SUBMIT' ? 'SUBMITTING' : 'RECOVERING';
    this.phase(found.request.requestId, status, null, found.request.allocationCids);
    return true;
  }

  confirm(id: string, confirmation: Confirmation): Promise<void> {
    this.confirmed.add(id);
    this.phase(
      this.preparation(id).request.requestId,
      confirmation.status,
      confirmation.result,
      confirmation.allocationCids,
    );
    return Promise.resolve();
  }

  uncertain(id: string): Promise<void> {
    const found = this.preparation(id);
    const requestId = found.request.requestId;
    const status = found.action === 'SUBMIT' ? 'UNRESOLVED' : 'RECOVERY_UNRESOLVED';
    this.phase(requestId, status, null, this.get(requestId).allocationCids);
    return Promise.resolve();
  }

  rejected(): Promise<void> {
    return Promise.reject(new Error('No liquidity workflow test rejects a submission'));
  }

  unresolved(): Promise<Pending[]> {
    const open = [...this.pending.values()].filter((p) => p.signature !== null && !this.confirmed.has(p.preparationId));
    return Promise.all(open.map((p) => this.pendingOwned(p.preparationId, TRADER)));
  }

  tracked(): Promise<Pending[]> {
    const open = [...this.pending.values()].filter(
      (p) =>
        p.action === 'SUBMIT' &&
        this.confirmed.has(p.preparationId) &&
        !['SETTLED', 'RECOVERED'].includes(this.get(p.request.requestId).status),
    );
    return Promise.all(open.map((p) => this.pendingOwned(p.preparationId, TRADER)));
  }

  latestRecovery(id: string): Promise<Pending | undefined> {
    return Promise.resolve(
      [...this.pending.values()].filter((p) => p.request.requestId === id && p.action === 'RECOVER').at(-1),
    );
  }

  async saveRecovery(
    id: string,
    preparation: string,
    command: string,
    caller: Account,
    signing: SigningPayload,
  ): Promise<Pending> {
    const value: Pending = {
      request: await this.owned(id, caller),
      accountId: caller.id,
      preparationId: preparation,
      commandId: command,
      action: 'RECOVER',
      signing,
      signature: null,
      beginOffset: 0n,
    };
    this.pending.set(preparation, value);
    return value;
  }

  activity(): Promise<Activity> {
    return Promise.reject(new Error('Not used by the workflow tests'));
  }

  private preparation(id: string): Pending {
    const found = this.pending.get(id);
    if (!found) throw new NotFound();
    return found;
  }

  private phase(id: string, status: LiquidityStatus, result: Result | null, allocationCids: readonly string[]): void {
    const request = this.get(id);
    this.requests.set(id, {
      ...request,
      status,
      updatedAt: instantText(this.clock.now),
      result,
      allocationCids,
      updateId: 'update',
      errorCode: null,
      error: null,
      canRecover: false,
    });
  }
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  const error = await run.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  return error instanceof Conflict ? error.code : undefined;
}

describe('liquidity workflow', () => {
  let clock: TestClock;
  let store: Progress;
  let ledger: Ledger;
  let workflow: LiquidityWorkflow;

  beforeEach(() => {
    clock = new TestClock();
    store = new Progress(clock);
    ledger = new Ledger(clock);
    workflow = new LiquidityWorkflow(store, ledger, SILENT_LOG, clock.read);
  });

  async function prepare(kind: Kind): Promise<Preparation> {
    if (kind === 'DEPOSIT') {
      const q = await workflow.quoteDeposit(TRADER, 'token', {
        poolId: 'pool',
        maxBaseAmount: '10',
        maxQuoteAmount: '25',
        slippageBps: 100,
      });
      return workflow.prepareDeposit(TRADER, 'token', {
        quoteId: q.quoteId,
        minLpOut: q.minLpOut,
        minRatio: q.minRatio,
        maxRatio: q.maxRatio,
        settlementDeadline: epochNanos(q.settlementDeadline),
      });
    }
    const q = await workflow.quoteWithdrawal(TRADER, 'token', { poolId: 'pool', lpAmount: '1', slippageBps: 100 });
    return workflow.prepareWithdrawal(TRADER, 'token', {
      quoteId: q.quoteId,
      minBaseOut: q.minBaseOut,
      minQuoteOut: q.minQuoteOut,
      settlementDeadline: epochNanos(q.settlementDeadline),
    });
  }

  function signed(prepared: Preparation): Submission {
    return { preparationId: prepared.preparationId, signature: SIGNATURE };
  }

  it('a deposit and a withdrawal keep the signed terms and dispatch each preparation once', async () => {
    for (const kind of KINDS) {
      const prepared = await prepare(kind);
      expect(prepared.action).toBe('SUBMIT');
      expect(prepared.recoveryEffects).toEqual([]);
      expect((await workflow.submit(kind, TRADER, 'token', signed(prepared))).status).toBe('READY');
      await workflow.submit(kind, TRADER, 'token', signed(prepared));
      expect(store.get(prepared.requestId).terms).toEqual(prepared.terms);
    }
    expect(ledger.submissions).toBe(2);
    expect(ledger.verifications).toBe(2);
  });

  it('ownership, kind and signature are checked before dispatch', async () => {
    const prepared = await prepare('DEPOSIT');
    const stranger: Account = {
      id: randomUUID(),
      issuer: 'issuer',
      subject: 'other',
      displayName: 'Other',
      role: 'TRADER',
    };
    await expect(workflow.get(prepared.requestId, 'DEPOSIT', stranger)).rejects.toThrow(NotFound);
    await expect(workflow.submit('WITHDRAW', TRADER, 'token', signed(prepared))).rejects.toThrow(NotFound);
    ledger.badSignature = true;
    await expect(workflow.submit('DEPOSIT', TRADER, 'token', signed(prepared))).rejects.toThrow(InvalidRequest);
    expect(ledger.submissions).toBe(0);
    expect(store.get(prepared.requestId).status).toBe('PREPARED');
    const operator: Account = {
      id: randomUUID(),
      issuer: 'issuer',
      subject: 'operator',
      displayName: 'Operator',
      role: 'OPERATOR',
    };
    await expect(workflow.positions(operator, 'token')).rejects.toThrow(AccessDenied);
  });

  it('a prepared quote cannot change the signed limits or reuse an expired preparation', async () => {
    const quote = await workflow.quoteDeposit(TRADER, 'token', {
      poolId: 'pool',
      maxBaseAmount: '10',
      maxQuoteAmount: '25',
      slippageBps: 100,
    });
    const input = {
      quoteId: quote.quoteId,
      minLpOut: quote.minLpOut,
      minRatio: quote.minRatio,
      maxRatio: quote.maxRatio,
      settlementDeadline: epochNanos(quote.settlementDeadline),
    };
    const prepared = await workflow.prepareDeposit(TRADER, 'token', input);
    expect(await workflow.prepareDeposit(TRADER, 'token', input)).toEqual(prepared);
    expect(await code(workflow.prepareDeposit(TRADER, 'token', { ...input, minLpOut: '8' }))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    clock.now = epochNanos(prepared.expiresAt);
    expect(await code(workflow.prepareDeposit(TRADER, 'token', input))).toBe('PREPARATION_EXPIRED');
    expect(ledger.preparations).toBe(1);
  });

  it('revocation blocks cached preparations and dispatch without hiding progress', async () => {
    for (const kind of KINDS) {
      const prepared = await prepare(kind);
      const request = store.get(prepared.requestId);
      const terms = prepared.terms;
      ledger.accessRevoked = true;
      const again =
        'mode' in terms
          ? workflow.prepareDeposit(TRADER, 'token', {
              quoteId: request.quoteId,
              minLpOut: terms.minLpOut,
              minRatio: terms.minRatio,
              maxRatio: terms.maxRatio,
              settlementDeadline: epochNanos(terms.settlementDeadline),
            })
          : workflow.prepareWithdrawal(TRADER, 'token', {
              quoteId: request.quoteId,
              minBaseOut: terms.minBaseOut,
              minQuoteOut: terms.minQuoteOut,
              settlementDeadline: epochNanos(terms.settlementDeadline),
            });
      expect(await code(again)).toBe('POOL_ACCESS_REQUIRED');
      expect(await code(workflow.submit(kind, TRADER, 'token', signed(prepared)))).toBe('POOL_ACCESS_REQUIRED');
      expect((await store.pendingOwned(prepared.preparationId, TRADER)).signature).toBeNull();
      expect((await workflow.get(prepared.requestId, kind, TRADER)).status).toBe('PREPARED');
      ledger.accessRevoked = false;
      await workflow.submit(kind, TRADER, 'token', signed(prepared));
      clock.now = epochNanos(terms.settlementDeadline);
      const recovery = await workflow.prepareRecovery(prepared.requestId, kind, TRADER, 'token');
      ledger.accessRevoked = true;
      expect(await code(workflow.prepareRecovery(prepared.requestId, kind, TRADER, 'token'))).toBe(
        'POOL_ACCESS_REQUIRED',
      );
      expect(await code(workflow.recover(prepared.requestId, kind, TRADER, 'token', signed(recovery)))).toBe(
        'POOL_ACCESS_REQUIRED',
      );
      expect((await store.pendingOwned(recovery.preparationId, TRADER)).signature).toBeNull();
      expect((await workflow.submit(kind, TRADER, 'token', signed(prepared))).status).toBe('READY');
      ledger.accessRevoked = false;
    }
    expect(ledger.submissions).toBe(2);
    expect(ledger.recoveries).toBe(0);
  });

  it('an unknown submission recovers its evidence after a restart without replay', async () => {
    const prepared = await prepare('DEPOSIT');
    ledger.failure = new Error('response lost');
    expect((await workflow.submit('DEPOSIT', TRADER, 'token', signed(prepared))).status).toBe('UNRESOLVED');
    await workflow.submit('DEPOSIT', TRADER, 'token', signed(prepared));
    await workflow.reconcile();
    expect(store.get(prepared.requestId).status).toBe('UNRESOLVED');
    ledger.evidence = ledger.confirmation('READY');
    await new LiquidityWorkflow(store, ledger, SILENT_LOG, clock.read).reconcile();
    expect(store.get(prepared.requestId).status).toBe('READY');
    expect(ledger.submissions).toBe(1);
  });

  it('an expired recovery shows only the remaining effects and requires terminal evidence', async () => {
    const prepared = await prepare('WITHDRAW');
    await workflow.submit('WITHDRAW', TRADER, 'token', signed(prepared));
    expect(await code(workflow.prepareRecovery(prepared.requestId, 'WITHDRAW', TRADER, 'token'))).toBe(
      'DEADLINE_NOT_ELAPSED',
    );
    clock.now = epochNanos(prepared.terms.settlementDeadline);
    const recover = await workflow.prepareRecovery(prepared.requestId, 'WITHDRAW', TRADER, 'token');
    expect(recover.recoveryEffects).toEqual([
      { allocationCid: 'lp', instrument: LP, amount: '1', kind: 'RETURN_FUNDS' },
      { allocationCid: 'quote', instrument: QUOTE, amount: '0', kind: 'RELEASE_PERMISSION' },
    ]);
    ledger.failure = new Error('response lost');
    expect((await workflow.recover(prepared.requestId, 'WITHDRAW', TRADER, 'token', signed(recover))).status).toBe(
      'RECOVERY_UNRESOLVED',
    );
    await workflow.recover(prepared.requestId, 'WITHDRAW', TRADER, 'token', signed(recover));
    ledger.evidence = ledger.confirmation('RECOVERED');
    await new LiquidityWorkflow(store, ledger, SILENT_LOG, clock.read).reconcile();
    expect(store.get(prepared.requestId).status).toBe('RECOVERED');
    expect(store.get(prepared.requestId).canRecover).toBe(false);
    expect(ledger.recoveries).toBe(1);
  });

  it('an observed settlement preserves the actual results and the wire terms stay concrete', async () => {
    const prepared = await prepare('DEPOSIT');
    await workflow.submit('DEPOSIT', TRADER, 'token', signed(prepared));
    clock.now = epochNanos(prepared.terms.settlementDeadline);
    await workflow.prepareRecovery(prepared.requestId, 'DEPOSIT', TRADER, 'token');
    const actual = {
      actualBaseIn: '10',
      actualQuoteIn: '20',
      actualBaseRefund: '0',
      actualQuoteRefund: '5',
      actualLpOut: '10',
    };
    ledger.observation = {
      status: 'SETTLED',
      allocationCids: ['base', 'quote', 'lp'],
      result: actual,
      updateId: 'settled',
      offset: 44n,
      confirmedAt: instantText(clock.now),
    };
    await workflow.reconcile();
    const request = store.get(prepared.requestId);
    expect(request.result).toEqual(actual);
    expect(await code(workflow.prepareRecovery(prepared.requestId, 'DEPOSIT', TRADER, 'token'))).toBe(
      'RECOVERY_UNAVAILABLE',
    );
    const tree = JSON.parse(jsonText(request)) as { kind: string; terms: Record<string, unknown>; result: Result };
    expect(tree.kind).toBe('DEPOSIT');
    expect(tree.terms.maxBaseAmount).toBe('10');
    expect('actualQuoteRefund' in tree.result && tree.result.actualQuoteRefund).toBe('5');
    expect('kind' in tree.terms).toBe(false);
  });
});
