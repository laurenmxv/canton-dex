import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../../src/iam/accounts.js';
import { KINDS } from '../../../src/liquidity/model.js';
import type { Family } from '../../../src/platform/families.js';
import { instantText } from '../../../src/platform/time.js';
import {
  FAMILIES,
  reference,
  requestId,
  sameRef,
  type Confirmation,
  type Fill,
  type History,
  type Monitoring,
  type Pending,
  type Plan,
  type Policy,
  type PreviewStep,
  type QueueRequest,
  type RequestRef,
  type Reserves,
  type Settlement,
  type SettlementStatus,
  type Snapshot,
  type Trigger,
  type UpdatePolicy,
} from '../../../src/settlements/model.js';
import {
  RequestBlocked,
  SettlementExcluded,
  SettlementRejected,
  type SettlementLedger,
  type SettlementProgress,
} from '../../../src/settlements/ports.js';
import { prefix, select } from '../../../src/settlements/selection.js';
import { SettlementStore } from '../../../src/settlements/store.js';
import { SettlementWorkflow } from '../../../src/settlements/workflow.js';
import type { SwapStatus } from '../../../src/swaps/model.js';
import { liquidity, NOW, swap, withoutDatabase } from './fixtures.js';

const OPERATOR: Account = {
  id: randomUUID(),
  issuer: 'issuer',
  subject: 'operator',
  displayName: 'Operator',
  role: 'OPERATOR',
};
const RESERVES: Reserves = {
  stateId: 'state',
  baseReserve: '100',
  quoteReserve: '200',
  spotPrice: '2',
  invariant: '20000',
};
const OBSERVED = instantText(NOW);
const SNAPSHOT = snapshot('state-v1', 42n);
const SILENT_LOG = { warn: () => undefined };
const CLOCK = () => NOW;
const UNUSED = 'Not used by the workflow tests';
const WAIT_MS = 2_000;

function snapshot(version: string, ledgerOffset: bigint): Snapshot {
  return {
    poolId: 'pool',
    version,
    reserves: RESERVES,
    feeBps: '30',
    health: 'READY',
    reason: null,
    observedAt: OBSERVED,
    ledgerOffset,
    lpTokenSupply: '100',
    initialRatio: '2',
  };
}

function policies(batchSize: number): Policy[] {
  return FAMILIES.map((type) => ({
    poolId: 'pool',
    type,
    automaticEnabled: true,
    batchSize,
    maxBatchSize: 10,
    version: 0n,
    updatedAt: instantText(0n),
  }));
}

function confirmation(pending: Pending): Confirmation {
  return {
    fills: pending.settlement.fills,
    before: RESERVES,
    after: { stateId: 'after', baseReserve: '110', quoteReserve: '182', spotPrice: '1.6545', invariant: '20020' },
    updateId: 'settlement-update',
    offset: 44n,
    confirmedAt: OBSERVED,
  };
}

/** A promise that resolves when the test releases it, and a signal that the operation reached it. */
function gate() {
  const entered = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  return {
    entered: entered.promise,
    hold: () => {
      entered.resolve(undefined);
      return released.promise;
    },
    release: () => {
      released.resolve(undefined);
    },
  };
}

/** The operation's result, or a failure when it waits longer than the 2 s bound. */
async function within<T>(operation: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timeout.reject(new Error('Test timed out'));
  }, WAIT_MS);
  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function fillOf(queued: QueueRequest): Fill {
  const id = requestId(queued);
  if (queued.type === 'swap') {
    return { requestId: id, amountOut: '18', outputInstrument: queued.request.outputInstrument, type: 'swap' };
  }
  if (queued.type === 'deposit') {
    return {
      requestId: id,
      actualBaseIn: '1',
      actualQuoteIn: '2',
      actualBaseRefund: '0',
      actualQuoteRefund: '0',
      actualLpOut: '1',
      type: 'deposit',
    };
  }
  return { requestId: id, actualLpBurned: '1', actualBaseOut: '1', actualQuoteOut: '2', type: 'withdraw' };
}

class Ledger implements SettlementLedger {
  snapshotValue = SNAPSHOT;
  blockedId: RequestRef | undefined;
  preflights = 0;
  submissions = 0;
  recoveries = 0;
  reverseFills = false;
  failure: Error | undefined;
  recoveryFailure: Error | undefined;
  submitted: Pending | undefined;
  beforePreflight: () => Promise<void> = () => Promise.resolve();
  beforeSubmit: () => Promise<void> = () => Promise.resolve();
  evidence: Confirmation | undefined;

  snapshot(): Promise<Snapshot> {
    return Promise.resolve(this.snapshotValue);
  }

  preview(): Promise<PreviewStep[]> {
    return Promise.resolve([]);
  }

  async preflight(_snapshot: Snapshot, requests: readonly QueueRequest[]): Promise<Fill[]> {
    this.preflights += 1;
    await this.beforePreflight();
    const blocked = this.blockedId;
    if (blocked && requests.some((queued) => sameRef(reference(queued), blocked))) {
      throw new RequestBlocked(blocked, 'MIN_OUT', 'Minimum output cannot be met');
    }
    const fills = requests.map(fillOf);
    return this.reverseFills ? fills.reverse() : fills;
  }

  async submit(pending: Pending): Promise<Confirmation> {
    this.submissions += 1;
    this.submitted = pending;
    await this.beforeSubmit();
    if (this.failure) throw this.failure;
    return confirmation(pending);
  }

  recover(): Promise<Confirmation | undefined> {
    this.recoveries += 1;
    if (this.recoveryFailure) return Promise.reject(this.recoveryFailure);
    return Promise.resolve(this.evidence);
  }
}

const ACTIVE: ReadonlySet<SettlementStatus> = new Set(['PREPARING', 'SUBMITTING', 'UNRESOLVED']);
const RECOVERABLE: ReadonlySet<SettlementStatus> = new Set(['SUBMITTING', 'UNRESOLVED']);

/** An in-memory double of the settlement store and its state transitions. */
class Progress implements SettlementProgress {
  queued: QueueRequest[] = [];
  claimed: readonly QueueRequest[] = [];
  batch: Settlement | undefined;
  stateVersion = '';
  beginOffset = 0n;
  automaticEnabled = false;
  policyVersion = 0n;
  batchSize = 3;
  blocked: RequestRef | undefined;
  blockedVersion: string | undefined;
  lastProcessedFamily: Family | null = null;
  exclusionCode: string | undefined;

  findIntent(_poolId: string, id: string): Promise<Settlement | undefined> {
    return this.find(id);
  }

  find(id: string): Promise<Settlement | undefined> {
    return Promise.resolve(this.batch?.settlementId === id ? this.batch : undefined);
  }

  get(): Promise<Settlement> {
    return this.batch ? Promise.resolve(this.batch) : Promise.reject(new Error(UNUSED));
  }

  updatePolicy(poolId: string, family: Family, input: UpdatePolicy, now: bigint): Promise<Policy> {
    this.automaticEnabled = input.automaticEnabled;
    this.batchSize = input.batchSize;
    this.policyVersion += 1n;
    return Promise.resolve({
      poolId,
      type: family,
      automaticEnabled: this.automaticEnabled,
      batchSize: this.batchSize,
      maxBatchSize: 10,
      version: this.policyVersion,
      updatedAt: instantText(now),
    });
  }

  automaticPools(): Promise<string[]> {
    return Promise.resolve(this.automaticEnabled ? ['pool'] : []);
  }

  claim(poolId: string, id: string, trigger: Trigger, value: Snapshot, now: bigint): Promise<Pending | undefined> {
    const automatic = trigger === 'AUTOMATIC';
    if (automatic && !this.automaticEnabled) return Promise.resolve(undefined);
    const blockedFamilies = new Set<Family>(automatic && this.blockedVersion === value.version ? ['swap'] : []);
    this.claimed = select(this.queued, policies(this.batchSize), this.lastProcessedFamily, blockedFamilies, automatic);
    const first = this.claimed[0];
    if (!first) return Promise.resolve(undefined);
    this.lastProcessedFamily = first.type;
    const at = instantText(now);
    this.batch = {
      settlementId: id,
      poolId,
      trigger,
      status: 'PREPARING',
      requests: this.claimed.map(reference),
      fills: [],
      before: value.reserves,
      after: null,
      policyVersion: this.policyVersion,
      createdAt: at,
      updatedAt: at,
      updateId: null,
      errorCode: null,
      error: null,
      retryOf: null,
    };
    this.stateVersion = value.version;
    this.beginOffset = value.ledgerOffset;
    return Promise.resolve(this.current());
  }

  pending(): Promise<Pending[]> {
    return Promise.resolve(this.batch && ACTIVE.has(this.batch.status) ? [this.current()] : []);
  }

  keepPrefix(
    _id: string,
    kept: readonly RequestRef[],
    blocked: RequestRef,
    code: string,
    reason: string,
    version: string,
    now: bigint,
  ): Promise<boolean> {
    const batch = this.required();
    this.blocked = blocked;
    this.blockedVersion = version;
    this.claimed = this.claimed.filter((queued) => kept.some((ref) => sameRef(ref, reference(queued))));
    this.batch = {
      ...batch,
      status: kept.length === 0 ? 'REJECTED' : 'PREPARING',
      requests: kept,
      fills: [],
      after: null,
      updatedAt: instantText(now),
      updateId: null,
      errorCode: code,
      error: reason,
      retryOf: null,
    };
    return Promise.resolve(true);
  }

  rejectPreparation(_id: string, blocked: RequestRef, _code: string, _reason: string, version: string): Promise<void> {
    this.blocked = blocked;
    this.blockedVersion = version;
    this.phase('REJECTED', []);
    return Promise.resolve();
  }

  cancelPreparation(): Promise<void> {
    if (this.required().status === 'PREPARING') this.phase('CANCELLED', []);
    return Promise.resolve();
  }

  authorizeDispatch(_id: string, fills: readonly Fill[], value: Snapshot): Promise<Pending | undefined> {
    const batch = this.required();
    if (batch.status !== 'PREPARING') return Promise.resolve(undefined);
    if (batch.trigger === 'AUTOMATIC' && (!this.automaticEnabled || batch.policyVersion !== this.policyVersion)) {
      this.phase('CANCELLED', []);
      return Promise.resolve(undefined);
    }
    this.stateVersion = value.version;
    this.beginOffset = value.ledgerOffset;
    this.phase('SUBMITTING', fills);
    return Promise.resolve(this.current());
  }

  unresolved(): Promise<void> {
    this.phase('UNRESOLVED', this.required().fills);
    return Promise.resolve();
  }

  rejectSubmission(): Promise<void> {
    const batch = this.required();
    if (batch.status !== 'SUBMITTING') return Promise.resolve();
    this.blockedVersion = this.stateVersion;
    this.phase('REJECTED', batch.fills);
    return Promise.resolve();
  }

  beginRecovery(id: string): Promise<boolean> {
    if (this.batch?.settlementId !== id || !RECOVERABLE.has(this.batch.status)) return Promise.resolve(false);
    this.phase('UNRESOLVED', this.batch.fills);
    return Promise.resolve(true);
  }

  excludeSubmission(id: string, code: string): Promise<void> {
    if (this.batch?.settlementId !== id || !RECOVERABLE.has(this.batch.status)) return Promise.resolve();
    this.exclusionCode = code;
    this.phase('REJECTED', this.batch.fills);
    return Promise.resolve();
  }

  confirm(_id: string, value: Confirmation): Promise<void> {
    this.phase('CONFIRMED', value.fills);
    return Promise.resolve();
  }

  policy(): Promise<Policy> {
    return Promise.reject(new Error(UNUSED));
  }

  plan(): Promise<Plan> {
    return Promise.reject(new Error(UNUSED));
  }

  setDeferred(): Promise<void> {
    return Promise.reject(new Error(UNUSED));
  }

  history(): Promise<History> {
    return Promise.reject(new Error(UNUSED));
  }

  list(): Promise<Settlement[]> {
    return Promise.reject(new Error(UNUSED));
  }

  monitoring(): Promise<Monitoring> {
    return Promise.reject(new Error(UNUSED));
  }

  queue(): Promise<QueueRequest[]> {
    return Promise.reject(new Error(UNUSED));
  }

  required(): Settlement {
    if (!this.batch) throw new Error('No batch was claimed');
    return this.batch;
  }

  private current(): Pending {
    const batch = this.required();
    return {
      settlement: batch,
      requests: this.claimed,
      commandId: batch.settlementId,
      beginOffset: this.beginOffset,
      stateVersion: this.stateVersion,
      selection: null,
    };
  }

  private phase(status: SettlementStatus, fills: readonly Fill[]): void {
    this.batch = { ...this.required(), status, fills, updatedAt: OBSERVED, retryOf: null };
  }
}

function run(workflow: SettlementWorkflow, poolId = 'pool', idempotencyKey: string = randomUUID()) {
  return workflow.run(poolId, { idempotencyKey, selection: null }, OPERATOR);
}

describe('settlement workflow', () => {
  let store: Progress;
  let ledger: Ledger;
  let workflow: SettlementWorkflow;

  beforeEach(() => {
    store = new Progress();
    ledger = new Ledger();
    workflow = new SettlementWorkflow(store, ledger, SILENT_LOG, CLOCK);
  });

  function restarted(): SettlementWorkflow {
    return new SettlementWorkflow(store, ledger, SILENT_LOG, CLOCK);
  }

  it('the configured batch maximum must fit the Daml limit at startup', () => {
    const db = withoutDatabase();
    for (const invalid of [0, 21, -2_147_483_648, 2_147_483_647]) {
      expect(() => new SettlementStore(db, invalid), `maximum batch size ${String(invalid)}`).toThrow(RangeError);
    }
    for (const supported of [1, 20]) {
      expect(() => new SettlementStore(db, supported), `maximum batch size ${String(supported)}`).not.toThrow();
    }
  });

  it('a manual settlement and a repeated key submit exactly once', async () => {
    store.queued = [swap(1n), swap(2n)];
    const key = randomUUID();
    const result = await run(workflow, 'pool', key);
    expect(result.status).toBe('CONFIRMED');
    expect(ledger.submitted?.requests.map(reference)).toEqual(store.queued.map(reference));
    expect(await run(workflow, 'pool', key)).toEqual(result);
    expect(ledger.submissions).toBe(1);
    await expect(run(workflow, 'another-pool', key)).rejects.toThrow('another pool');
  });

  it('a manual preflight settles the valid prefix and keeps the blocked suffix out', async () => {
    const first = swap(1n);
    const blocked = swap(2n);
    store.queued = [first, blocked, swap(3n)];
    ledger.blockedId = reference(blocked);
    const result = await run(workflow);
    expect(result.status).toBe('CONFIRMED');
    expect(ledger.submitted?.requests.map(reference)).toEqual([reference(first)]);
    expect(store.blocked).toEqual(ledger.blockedId);
    expect(ledger.preflights).toBe(2);
  });

  it('automatic never submits a partial batch after a preflight failure', async () => {
    const blocked = swap(2n);
    store.queued = [swap(1n), blocked, swap(3n)];
    store.automaticEnabled = true;
    ledger.blockedId = reference(blocked);
    await workflow.automatic();
    expect(store.required().status).toBe('REJECTED');
    expect(store.blockedVersion).toBe(SNAPSHOT.version);
    await workflow.automatic();
    await workflow.automatic();
    expect(ledger.preflights).toBe(1);
    expect(ledger.submissions).toBe(0);
  });

  it('automatic liquidity submits the valid prefix and reconciles it after a lost response', async () => {
    for (const kind of KINDS) {
      const store = new Progress();
      const ledger = new Ledger();
      const workflow = new SettlementWorkflow(store, ledger, SILENT_LOG, CLOCK);
      const first = liquidity(1n, kind, 'READY');
      const second = liquidity(2n, kind, 'READY');
      const blocked = liquidity(3n, kind, 'READY');
      store.queued = [first, second, blocked];
      store.automaticEnabled = true;
      ledger.blockedId = reference(blocked);
      ledger.failure = new Error('response lost');
      await workflow.automatic();
      expect(store.required().status).toBe('UNRESOLVED');
      expect(ledger.submitted?.requests).toEqual([first, second]);
      expect(store.blocked).toEqual(reference(blocked));
      expect(ledger.preflights).toBe(2);
      if (ledger.submitted) ledger.evidence = confirmation(ledger.submitted);
      await new SettlementWorkflow(store, ledger, SILENT_LOG, CLOCK).reconcile();
      expect(store.required().status).toBe('CONFIRMED');
      expect(store.required().fills.map((fill) => fill.requestId)).toEqual([requestId(first), requestId(second)]);
      expect(ledger.submissions).toBe(1);
    }
  });

  it('a lost response is recovered after a restart even with automatic disabled', async () => {
    store.queued = [swap(1n)];
    ledger.failure = new Error('response lost');
    const result = await run(workflow);
    expect(result.status).toBe('UNRESOLVED');
    expect(ledger.submitted?.commandId).toBe(result.settlementId);
    expect(ledger.submitted?.beginOffset).toBe(42n);
    await workflow.reconcile();
    expect(store.required().status).toBe('UNRESOLVED');
    if (ledger.submitted) ledger.evidence = confirmation(ledger.submitted);
    await restarted().reconcile();
    expect(store.required().status).toBe('CONFIRMED');
    expect(ledger.submissions).toBe(1);
  });

  it('a proven exclusion releases an unknown batch without resubmission and allows a fresh batch', async () => {
    store.queued = [swap(1n)];
    ledger.failure = new Error('response lost');
    const original = await run(workflow);
    expect(original.status).toBe('UNRESOLVED');

    ledger.recoveryFailure = new SettlementExcluded('INPUT_CONSUMED', 'Original batch can no longer commit');
    await restarted().reconcile();
    expect(store.required().settlementId).toBe(original.settlementId);
    expect(store.required().status).toBe('REJECTED');
    expect(store.exclusionCode).toBe('INPUT_CONSUMED');
    expect(await store.pending()).toEqual([]);
    expect(ledger.submissions).toBe(1);
    expect(ledger.recoveries).toBe(1);

    ledger.failure = undefined;
    ledger.recoveryFailure = undefined;
    store.queued = [swap(2n)];
    const fresh = await run(workflow);
    expect(fresh.settlementId).not.toBe(original.settlementId);
    expect(fresh.status).toBe('CONFIRMED');
    expect(ledger.submissions).toBe(2);
  });

  it('a durable preparation failure releases the pool before or after a restart', async () => {
    const notPrepared = new SettlementExcluded('COMMAND_NOT_PREPARED', 'No command was sent');
    store.queued = [swap(1n)];
    ledger.failure = notPrepared;
    expect((await run(workflow)).status).toBe('REJECTED');
    expect(await store.pending()).toEqual([]);

    ledger.failure = new Error('response lost before preparation result');
    await run(workflow);
    ledger.recoveryFailure = notPrepared;
    await restarted().reconcile();
    expect(store.exclusionCode).toBe('COMMAND_NOT_PREPARED');
    expect(await store.pending()).toEqual([]);
    ledger.failure = undefined;
    ledger.recoveryFailure = undefined;
    expect((await run(workflow)).status).toBe('CONFIRMED');
  });

  it('a rejected recovery attempt does not prove that the original unknown batch had no effect', async () => {
    store.queued = [swap(1n)];
    ledger.failure = new Error('response lost');
    const original = await run(workflow);
    ledger.recoveryFailure = new SettlementRejected('REPLAY_REJECTED', 'Recovery attempt rejected');
    await workflow.reconcile();

    expect(store.required().settlementId).toBe(original.settlementId);
    expect(store.required().status).toBe('UNRESOLVED');
    expect(await store.pending()).toHaveLength(1);
    expect(store.exclusionCode).toBeUndefined();
    expect(ledger.submissions).toBe(1);
    expect(ledger.recoveries).toBe(1);
  });

  it('a definitive rejection blocks automatic retry until the snapshot changes', async () => {
    store.queued = [swap(1n), swap(2n), swap(3n)];
    store.automaticEnabled = true;
    ledger.failure = new SettlementRejected('MIN_OUT', 'Output changed');
    await workflow.automatic();
    await workflow.automatic();
    expect(store.required().status).toBe('REJECTED');
    expect(ledger.submissions).toBe(1);
    ledger.snapshotValue = snapshot('state-v2', 43n);
    ledger.failure = undefined;
    await workflow.automatic();
    expect(store.required().status).toBe('CONFIRMED');
    expect(ledger.submissions).toBe(2);
  });

  it('disabling during preflight returns without waiting and prevents dispatch', async () => {
    store.queued = [swap(1n), swap(2n), swap(3n)];
    store.automaticEnabled = true;
    const preflight = gate();
    ledger.beforePreflight = preflight.hold;
    try {
      const operation = workflow.automatic();
      await within(preflight.entered);
      const policy = await within(
        workflow.updatePolicy('pool', 'swap', { automaticEnabled: false, batchSize: 3, expectedVersion: 0n }, OPERATOR),
      );
      expect(policy.automaticEnabled).toBe(false);
      preflight.release();
      await within(operation);
    } finally {
      preflight.release();
    }
    expect(ledger.submissions).toBe(0);
    expect(store.required().status).toBe('CANCELLED');
  });

  it('disabling after authorization allows the already submitted batch to finish', async () => {
    store.queued = [swap(1n), swap(2n), swap(3n)];
    store.automaticEnabled = true;
    const submission = gate();
    ledger.beforeSubmit = submission.hold;
    try {
      const operation = workflow.automatic();
      await within(submission.entered);
      await within(
        workflow.updatePolicy('pool', 'swap', { automaticEnabled: false, batchSize: 3, expectedVersion: 0n }, OPERATOR),
      );
      submission.release();
      await within(operation);
    } finally {
      submission.release();
    }
    expect(store.required().status).toBe('CONFIRMED');
    expect(ledger.submissions).toBe(1);
  });

  it('FIFO stops at an unknown request or a withdrawal even after its deadline', () => {
    const ready = swap(1n);
    const elapsed = instantText(NOW - 1_000_000_000n);
    const uncertain: SwapStatus[] = ['SUBMITTING', 'UNRESOLVED', 'WITHDRAWING', 'WITHDRAWAL_UNRESOLVED'];
    for (const status of uncertain) {
      const barrier = swap(2n, status, elapsed);
      expect(prefix([ready, barrier, swap(3n)], 5)).toEqual([ready]);
      expect(prefix([barrier, ready], 5)).toEqual([]);
    }
  });

  it('a prepared batch after a restart uses a fresh snapshot before authorization', async () => {
    store.queued = [swap(1n)];
    await store.claim('pool', randomUUID(), 'MANUAL', SNAPSHOT, NOW);
    ledger.snapshotValue = snapshot('new-state', 99n);
    await workflow.reconcile();
    expect(ledger.submitted?.stateVersion).toBe('new-state');
    expect(ledger.submitted?.beginOffset).toBe(99n);
    expect(ledger.submissions).toBe(1);
  });

  it('an invalid fill order cannot reach submission', async () => {
    store.queued = [swap(1n), swap(2n)];
    ledger.reverseFills = true;
    expect((await run(workflow)).status).toBe('CANCELLED');
    expect(ledger.submissions).toBe(0);
  });

  it('independent families rotate and preserve their own FIFO', () => {
    const firstSwap = swap(1n);
    const secondSwap = swap(2n);
    const deposit = liquidity(1n, 'DEPOSIT', 'READY');
    const laterDeposit = liquidity(2n, 'DEPOSIT', 'READY');
    const withdrawal = liquidity(1n, 'WITHDRAW', 'READY');
    const laterWithdrawal = liquidity(2n, 'WITHDRAW', 'READY');
    const queues = [laterWithdrawal, withdrawal, laterDeposit, secondSwap, deposit, firstSwap];
    const none = new Set<Family>();
    expect(select(queues, policies(2), null, none, true)).toEqual([firstSwap, secondSwap]);
    expect(select(queues, policies(5), 'swap', none, true)).toEqual([deposit, laterDeposit]);
    expect(select(queues, policies(1), 'swap', none, true)).toEqual([deposit]);
    expect(select([deposit, laterDeposit], policies(5), null, none, true)).toEqual([deposit, laterDeposit]);
    expect(select(queues, policies(5), 'deposit', none, true)).toEqual([withdrawal, laterWithdrawal]);
    expect(select(queues, policies(1), 'deposit', none, true)).toEqual([withdrawal]);
    expect(select([withdrawal, laterWithdrawal], policies(5), null, none, true)).toEqual([withdrawal, laterWithdrawal]);
    expect(select(queues, policies(2), 'withdraw', none, true)).toEqual([firstSwap, secondSwap]);
    expect(select([firstSwap], policies(5), null, none, true)).toEqual([]);
  });

  it('a blocked or uncertain family does not block other families', () => {
    const single = swap(1n);
    const recovering = liquidity(1n, 'WITHDRAW', 'RECOVERY_UNRESOLVED');
    const laterWithdrawal = liquidity(2n, 'WITHDRAW', 'READY');
    const deposit = liquidity(1n, 'DEPOSIT', 'BLOCKED');
    const queues = [recovering, laterWithdrawal, single, deposit];
    expect(select(queues, policies(1), 'swap', new Set(['deposit']), true)).toEqual([single]);
    expect(select([recovering, laterWithdrawal, deposit], policies(5), 'swap', new Set(), true)).toEqual([deposit]);
  });

  it('initialization remains individual and liquidity batches stop at unresolved requests', () => {
    const initial = liquidity(2n, 'DEPOSIT', 'READY', 'INITIAL');
    const first = liquidity(1n, 'DEPOSIT', 'READY');
    const later = liquidity(3n, 'DEPOSIT', 'READY');
    expect(prefix([initial, later], 5)).toEqual([initial]);
    expect(prefix([first, initial, later], 5)).toEqual([first]);
    for (const kind of KINDS) {
      const ready = liquidity(1n, kind, 'READY');
      const recovering = liquidity(2n, kind, 'RECOVERY_UNRESOLVED');
      const tail = liquidity(3n, kind, 'READY');
      expect(prefix([ready, recovering, tail], 5)).toEqual([ready]);
    }
  });
});
