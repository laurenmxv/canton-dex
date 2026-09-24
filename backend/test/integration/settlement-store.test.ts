import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../src/iam/accounts.js';
import type { Kind, Request, Terms as LiquidityTerms } from '../../src/liquidity/model.js';
import { LiquidityStore } from '../../src/liquidity/store.js';
import { OperatorCommandStore, type PreparedCommand } from '../../src/operations/commands.js';
import type { Family } from '../../src/platform/database.js';
import { CodedFailure, Conflict, InvalidRequest, NotFound } from '../../src/platform/errors.js';
import { jsonText } from '../../src/platform/json.js';
import { clockNanos, instantText } from '../../src/platform/time.js';
import {
  BATCH_IN_FLIGHT,
  FAMILIES,
  POLICY_CHANGED,
  POOL_CHANGED,
  QUEUE_CHANGED,
  reference,
  sameRef,
  selection,
  type Confirmation,
  type Fill,
  type Pending,
  type QueueRequest,
  type RequestRef,
  type Reserves,
  type Snapshot,
  type Trigger,
  type UpdatePolicy,
} from '../../src/settlements/model.js';
import { SettlementStore } from '../../src/settlements/store.js';
import type { SwapStatus, Terms } from '../../src/swaps/model.js';
import { scenario } from './support/scenario.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_SETTLEMENT_TEST_DATABASE_URL;
const SECOND = 1_000_000_000n;
const MICROSECOND = 1_000n;
const LOCKED_ALLOCATION = 'locked-allocation';

/** Starts both operations before either completes; each runs on its own pooled connection. */
function concurrent<T>(first: () => Promise<T>, second: () => Promise<T>): Promise<[T, T]> {
  return Promise.all([first(), second()]);
}

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value');
  return value;
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error('Expected a failure');
    },
    (error: unknown) => error,
  );
}

/** A coded workflow failure: a conflict, or a failure with its own status and code. */
async function workflowFailure(run: Promise<unknown>): Promise<Conflict | CodedFailure> {
  const error = await rejection(run);
  if (error instanceof Conflict || error instanceof CodedFailure) return error;
  throw new Error('Expected a workflow failure', { cause: error });
}

async function code(run: Promise<unknown>): Promise<string | undefined> {
  return (await workflowFailure(run)).code;
}

describe.runIf(scenario('swaps') && DATABASE_URL)('settlement store', () => {
  const account = randomUUID();
  const caller: Account = { id: account, issuer: 'test', subject: 'trader', displayName: 'Trader', role: 'TRADER' };
  const now = (clockNanos() / MICROSECOND) * MICROSECOND;
  const reserves: Reserves = {
    stateId: 'state',
    baseReserve: '100',
    quoteReserve: '200',
    spotPrice: '2',
    invariant: '20000',
  };
  const snapshot = poolSnapshot('version-1', 42n);
  let scratch: ScratchDatabase;
  let store: SettlementStore;

  function poolSnapshot(version: string, ledgerOffset: bigint): Snapshot {
    return {
      poolId: 'pool',
      version,
      reserves,
      feeBps: '30',
      health: 'READY',
      reason: null,
      observedAt: instantText(now),
      ledgerOffset,
      lpTokenSupply: '100',
      initialRatio: '2',
    };
  }

  function after(seconds: number): bigint {
    return now + BigInt(seconds) * SECOND;
  }

  /** A store on a new connection pool, as a restarted process opens it. */
  function restarted(maxBatchSize = 10): SettlementStore {
    return new SettlementStore(scratch.reopen(), maxBatchSize);
  }

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
    store = new SettlementStore(scratch.db, 10);
    await sql`INSERT INTO accounts(id,issuer,subject,display_name,role)
      VALUES(${account},'test','trader','Trader','TRADER')`.execute(scratch.db);
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
      VALUES('pool','config','state','package','Pool')`.execute(scratch.db);
  });

  afterEach(() => scratch.drop());

  async function insert(sequence: bigint, status: SwapStatus, deadline: bigint): Promise<string> {
    const quote = randomUUID();
    const swap = randomUUID();
    const terms: Terms = {
      poolId: 'pool',
      poolName: 'Pool',
      trader: 'trader',
      direction: 'BaseToQuote',
      inputInstrument: { admin: 'issuer', id: 'A' },
      outputInstrument: { admin: 'issuer', id: 'B' },
      amountIn: '10',
      expectedOut: '18',
      feeAmount: '0.03',
      minOut: '15',
      settlementDeadline: instantText(deadline),
    };
    await sql`INSERT INTO swap_quotes(id,account_id,payload,expires_at)
      VALUES(${quote},${account},'{}',now()+interval '1 hour')`.execute(scratch.db);
    await sql`INSERT INTO swap_requests(id,account_id,quote_id,terms,status,arrival_sequence,submitted_at,allocation_cids)
      VALUES(${swap},${account},${quote},${jsonText(terms)}::jsonb,${status},${sequence},now(),
        ${jsonText([LOCKED_ALLOCATION])}::jsonb)`.execute(scratch.db);
    return swap;
  }

  async function insertLiquidity(kind: Kind): Promise<Request> {
    const liquidity = new LiquidityStore(scratch.db, 10);
    const quote = randomUUID();
    const request = randomUUID();
    const preparation = randomUUID();
    await sql`INSERT INTO liquidity_quotes(id,account_id,kind,payload,expires_at)
      VALUES(${quote},${account},${kind},'{}',${instantText(after(600))})`.execute(scratch.db);
    const instruments = {
      baseInstrument: { admin: 'issuer', id: 'A' },
      quoteInstrument: { admin: 'issuer', id: 'B' },
      lpInstrument: { admin: 'dvo', id: 'LP' },
    };
    const deadline = instantText(after(600));
    const terms: LiquidityTerms =
      kind === 'DEPOSIT'
        ? {
            poolId: 'pool',
            poolName: 'Pool',
            trader: 'trader',
            ...instruments,
            mode: 'PROPORTIONAL',
            maxBaseAmount: '10',
            maxQuoteAmount: '25',
            expectedBaseAmount: '10',
            expectedQuoteAmount: '20',
            expectedBaseRefund: '0',
            expectedQuoteRefund: '5',
            expectedLpOut: '10',
            minLpOut: '9.9',
            minRatio: '1.98',
            maxRatio: '2.02',
            initialMinimumLp: null,
            settlementDeadline: deadline,
          }
        : {
            poolId: 'pool',
            poolName: 'Pool',
            trader: 'trader',
            ...instruments,
            lpAmount: '1',
            expectedBaseOut: '1',
            expectedQuoteOut: '2',
            minBaseOut: '0.99',
            minQuoteOut: '1.98',
            settlementDeadline: deadline,
          };
    const signing = {
      preparedTransaction: 'opaque',
      preparedTransactionHash: 'hash',
      hashingSchemeVersion: 3,
      partyId: 'trader',
      publicKeyFingerprint: 'key',
      expiresAt: instantText(after(45)),
      recoveryEffects: [],
    };
    await liquidity.savePreparation(request, preparation, request, quote, caller, terms, signing);
    expect(await liquidity.begin(preparation, caller, 'signature', 42n, now)).toBe(true);
    await liquidity.confirm(preparation, {
      status: 'READY',
      allocationCids: [`base-${request}`, `quote-${request}`, `lp-${request}`],
      result: null,
      updateId: `request-${request}`,
      offset: 43n,
      confirmedAt: instantText(now),
    });
    return liquidity.get(request);
  }

  async function readyRequest(family: Family, sequence: bigint): Promise<RequestRef> {
    const requestId =
      family === 'swap'
        ? await insert(sequence, 'READY', after(600))
        : (await insertLiquidity(family === 'deposit' ? 'DEPOSIT' : 'WITHDRAW')).requestId;
    return { type: family, requestId };
  }

  async function status(id: string): Promise<string | undefined> {
    const { rows } = await sql<{ status: string }>`SELECT status FROM swap_requests WHERE id=${id}`.execute(scratch.db);
    return rows[0]?.status;
  }

  async function allocations(id: string): Promise<string | undefined> {
    const { rows } = await sql<{ cids: string }>`SELECT allocation_cids::text AS cids FROM swap_requests
      WHERE id=${id}`.execute(scratch.db);
    return rows[0]?.cids;
  }

  async function blockedVersion(): Promise<string | null | undefined> {
    const { rows } = await sql<{ version: string | null }>`SELECT blocked_version AS version FROM pool_request_queues
      WHERE pool_id='pool' AND family='swap'`.execute(scratch.db);
    return rows[0]?.version;
  }

  async function setBlockedVersion(version: string): Promise<void> {
    await sql`UPDATE pool_request_queues SET blocked_version=${version}
      WHERE pool_id='pool' AND family='swap'`.execute(scratch.db);
  }

  async function queued(from: SettlementStore, ref: RequestRef): Promise<QueueRequest> {
    return present((await from.queue('pool')).find((row) => sameRef(reference(row), ref)));
  }

  function fills(pending: Pending): Fill[] {
    return pending.requests.map((queuedRequest) => {
      if (queuedRequest.type !== 'swap') throw new Error('Only swap fills');
      return {
        requestId: queuedRequest.request.swapId,
        amountOut: '18',
        outputInstrument: queuedRequest.request.outputInstrument,
        type: 'swap',
      };
    });
  }

  function confirmation(pending: Pending): Confirmation {
    return {
      fills: fills(pending),
      before: reserves,
      after: { stateId: 'after', baseReserve: '110', quoteReserve: '182', spotPrice: '1.65', invariant: '20020' },
      updateId: 'update',
      offset: 43n,
      confirmedAt: instantText(now),
    };
  }

  function claimed(trigger: Trigger, at = now, from = store): Promise<Pending> {
    return from.claim('pool', randomUUID(), trigger, snapshot, at).then(present);
  }

  async function claim(trigger: Trigger): Promise<boolean> {
    try {
      return (await store.claim('pool', randomUUID(), trigger, snapshot, now)) !== undefined;
    } catch (error) {
      expect(error instanceof Conflict ? error.code : error).toBe(BATCH_IN_FLIGHT);
      return false;
    }
  }

  async function update(input: UpdatePolicy): Promise<boolean> {
    try {
      await store.updatePolicy('pool', 'swap', input, now);
      return true;
    } catch (error) {
      expect(error instanceof Conflict ? error.code : error).toBe(POLICY_CHANGED);
      return false;
    }
  }

  function ids(refs: readonly RequestRef[]): string[] {
    return refs.map((ref) => ref.requestId);
  }

  it('concurrent prepared commands return the same immutable winner and reject cross-kind reuse', async () => {
    const commands = new OperatorCommandStore(scratch.db);
    const payload: PreparedCommand = { payload: 'payload-a' };
    const contenders: PreparedCommand[] = [{ payload: 'payload-b' }, { error: 'not prepared' }];
    for (const contender of contenders) {
      const id = randomUUID();
      expect(await commands.find(id, 'batch')).toBeUndefined();
      const results = await concurrent(
        () => commands.storeOnce(id, 'batch', payload),
        () => commands.storeOnce(id, 'batch', contender),
      );
      const [winner] = results;
      expect([payload, contender]).toContainEqual(winner);
      expect(results).toEqual([winner, winner]);
      expect(await commands.find(id, 'batch')).toEqual(winner);
      expect(await commands.storeOnce(id, 'batch', { payload: 'later-payload' })).toEqual(winner);
      expect(await commands.storeOnce(id, 'batch', { error: 'later-failure' })).toEqual(winner);
      await expect(commands.storeOnce(id, 'faucet-grant', payload)).rejects.toThrow('another operation kind');
      await expect(commands.find(id, 'faucet-grant')).rejects.toThrow('another operation kind');
      expect(await commands.find(id, 'batch')).toEqual(winner);
    }
  });

  it('policy compare-and-swap allows one writer and a stale slider cannot reactivate automation', async () => {
    await store.policy('pool', 'swap');
    const results = await concurrent(
      () => update({ automaticEnabled: true, batchSize: 2, expectedVersion: 0n }),
      () => update({ automaticEnabled: false, batchSize: 3, expectedVersion: 0n }),
    );
    expect(results.toSorted()).toEqual([false, true]);
    const policy = await store.policy('pool', 'swap');
    expect(policy.version).toBe(1n);
    await store.updatePolicy(
      'pool',
      'swap',
      { automaticEnabled: false, batchSize: 2, expectedVersion: policy.version },
      now,
    );
    const stale = await workflowFailure(
      store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 4, expectedVersion: 1n }, now),
    );
    expect(stale.message).toContain('changed');
    expect((await store.policy('pool', 'swap')).automaticEnabled).toBe(false);
  });

  it('queue policies have independent versions, sizes and dispatch authorization', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 2, expectedVersion: 0n }, now);
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: false, batchSize: 1, expectedVersion: 0n }, now);
    await store.updatePolicy('pool', 'withdraw', { automaticEnabled: true, batchSize: 3, expectedVersion: 0n }, now);
    await insert(1n, 'READY', after(600));
    await insert(2n, 'READY', after(600));
    await insertLiquidity('DEPOSIT');
    await insertLiquidity('DEPOSIT');
    await insertLiquidity('WITHDRAW');
    await insertLiquidity('WITHDRAW');
    expect((await store.plan('pool', 'deposit', null, null, snapshot, now)).requests).toHaveLength(1);
    expect((await store.plan('pool', 'withdraw', null, null, snapshot, now)).requests).toHaveLength(2);
    const preview = await store.plan('pool', 'swap', null, null, snapshot, now);
    expect(preview.requests).toHaveLength(2);
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: true, batchSize: 2, expectedVersion: 1n }, now);
    const manual = present(await store.claim('pool', randomUUID(), 'MANUAL', snapshot, now, preview.selection));
    expect(manual.settlement.requests).toEqual(preview.selection.requests);
    await store.cancelPreparation(manual.settlement.settlementId, 'TEST', 'Release test batch', now);
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: false, batchSize: 2, expectedVersion: 2n }, now);
    await store.updatePolicy('pool', 'withdraw', { automaticEnabled: false, batchSize: 3, expectedVersion: 1n }, now);
    const automatic = await claimed('AUTOMATIC');
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: true, batchSize: 1, expectedVersion: 3n }, now);
    expect(
      await store.authorizeDispatch(automatic.settlement.settlementId, fills(automatic), snapshot, now),
    ).toBeDefined();
    const reopened = restarted();
    expect((await reopened.policy('pool', 'swap')).version).toBe(1n);
    expect((await reopened.policy('pool', 'deposit')).version).toBe(4n);
    expect((await reopened.policy('pool', 'withdraw')).automaticEnabled).toBe(false);
    expect((await reopened.monitoring('pool', snapshot, now)).policies).toHaveLength(3);
  });

  it('automatic only selects enabled queues and manual can run a disabled queue', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 2, expectedVersion: 0n }, now);
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: false, batchSize: 1, expectedVersion: 0n }, now);
    await store.updatePolicy('pool', 'withdraw', { automaticEnabled: false, batchSize: 2, expectedVersion: 0n }, now);
    await insert(1n, 'READY', after(600));
    await insertLiquidity('DEPOSIT');
    const withdrawal = await insertLiquidity('WITHDRAW');
    expect(await store.claim('pool', randomUUID(), 'AUTOMATIC', snapshot, now)).toBeUndefined();
    await store.updatePolicy('pool', 'deposit', { automaticEnabled: true, batchSize: 1, expectedVersion: 1n }, now);
    expect(await store.automaticPools()).toEqual(['pool']);
    const deposit = await claimed('AUTOMATIC');
    expect(deposit.settlement.requests.map((ref) => ref.type)).toEqual(['deposit']);
    await store.cancelPreparation(deposit.settlement.settlementId, 'TEST', 'Release test batch', now);
    const preview = await store.plan('pool', 'withdraw', null, null, snapshot, now);
    const manual = present(await store.claim('pool', randomUUID(), 'MANUAL', snapshot, now, preview.selection));
    expect(manual.settlement.requests).toEqual([{ type: 'withdraw', requestId: withdrawal.requestId }]);
    // A family that bypasses the route check; the store checks it again.
    const unknownFamily = 'all' as Family;
    await expect(
      store.updatePolicy('pool', unknownFamily, { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now),
    ).rejects.toThrow(InvalidRequest);
  });

  it('a reduced maximum reports a policy mismatch until the operator saves a compatible size', async () => {
    const saved = await store.updatePolicy(
      'pool',
      'swap',
      { automaticEnabled: true, batchSize: 10, expectedVersion: 0n },
      now,
    );
    for (let sequence = 1n; sequence <= 5n; sequence += 1n) await insert(sequence, 'READY', after(60));
    const reopened = restarted(5);
    expect(await reopened.claim('pool', randomUUID(), 'AUTOMATIC', snapshot, now)).toBeUndefined();
    const limit = await workflowFailure(reopened.claim('pool', randomUUID(), 'MANUAL', snapshot, now));
    expect(limit.code).toBe('POLICY_LIMIT_EXCEEDED');
    expect(limit).toBeInstanceOf(Conflict);
    for (const part of ['10', '5', 'Update this queue']) expect(limit.message).toContain(part);
    const monitoring = await reopened.monitoring('pool', snapshot, now);
    expect(monitoring.blockedReason).toBeNull();
    expect(monitoring.blockedRequest).toBeNull();
    const swapPolicy = present(monitoring.policies.find((policy) => policy.type === 'swap'));
    expect(swapPolicy.batchSize).toBe(10);
    expect(swapPolicy.maxBatchSize).toBe(5);
    expect(swapPolicy.automaticEnabled).toBe(true);
    expect(swapPolicy.version).toBe(saved.version);
    expect(monitoring.readyCount).toBe(5);
    expect(await reopened.pending()).toEqual([]);
    await insertLiquidity('DEPOSIT');
    await reopened.updatePolicy('pool', 'deposit', { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now);
    const deposit = await claimed('AUTOMATIC', now, reopened);
    expect(deposit.settlement.requests.map((ref) => ref.type)).toEqual(['deposit']);
    await reopened.cancelPreparation(deposit.settlement.settlementId, 'TEST', 'Release test batch', now);
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
      VALUES('other-pool','other-config','other-state','package','Other pool')`.execute(scratch.db);
    expect((await reopened.policy('other-pool', 'swap')).batchSize).toBe(5);
    expect(await reopened.claim('other-pool', randomUUID(), 'MANUAL', snapshot, now)).toBeUndefined();
    const corrected = await reopened.updatePolicy(
      'pool',
      'swap',
      { automaticEnabled: true, batchSize: 5, expectedVersion: saved.version },
      now,
    );
    expect(corrected.version).toBe(saved.version + 1n);
    expect((await reopened.monitoring('pool', snapshot, now)).blockedReason).toBeNull();
    expect(ids((await claimed('AUTOMATIC', now, reopened)).settlement.requests)).toHaveLength(5);
  });

  it('a reduced maximum cancels only an unsent preparation and preserves the saved policy', async () => {
    const saved = await store.updatePolicy(
      'pool',
      'swap',
      { automaticEnabled: true, batchSize: 10, expectedVersion: 0n },
      now,
    );
    for (let sequence = 1n; sequence <= 10n; sequence += 1n) await insert(sequence, 'READY', after(60));
    const preparing = await claimed('AUTOMATIC');
    const reopened = restarted(5);
    const id = preparing.settlement.settlementId;
    expect(await reopened.authorizeDispatch(id, fills(preparing), snapshot, now)).toBeUndefined();
    expect((await reopened.get(id)).status).toBe('CANCELLED');
    expect((await reopened.get(id)).errorCode).toBe('POLICY_LIMIT_EXCEEDED');
    expect(await reopened.pending()).toEqual([]);
    expect(new Set((await reopened.queue('pool')).map((row) => row.request.status))).toEqual(new Set(['READY']));
    expect((await reopened.policy('pool', 'swap')).batchSize).toBe(10);
    expect((await reopened.policy('pool', 'swap')).version).toBe(saved.version);
    expect((await reopened.monitoring('pool', snapshot, now)).activeSettlement).toBeNull();
  });

  it('concurrent manual and automatic claims freeze only one batch', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 2, expectedVersion: 0n }, now);
    const first = await insert(1n, 'READY', after(60));
    const second = await insert(2n, 'READY', after(60));
    const results = await concurrent(
      () => claim('MANUAL'),
      () => claim('AUTOMATIC'),
    );
    expect(results.toSorted()).toEqual([false, true]);
    expect(await store.pending()).toHaveLength(1);
    const pending = present((await store.pending())[0]);
    expect(ids(pending.settlement.requests)).toEqual([first, second]);
    expect(await store.claim('pool', pending.settlement.settlementId, 'MANUAL', snapshot, now)).toBeUndefined();
    const { rows } = await sql<{ count: bigint }>`SELECT count(*) AS count FROM swap_requests
      WHERE status='SETTLING'`.execute(scratch.db);
    expect(rows).toEqual([{ count: 2n }]);
  });

  it('disabling before dispatch cancels an automatic claim and releases the queue', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now);
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('AUTOMATIC');
    await store.updatePolicy('pool', 'swap', { automaticEnabled: false, batchSize: 1, expectedVersion: 1n }, now);
    expect(
      await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now),
    ).toBeUndefined();
    expect((await store.get(pending.settlement.settlementId)).status).toBe('CANCELLED');
    expect(await status(swap)).toBe('READY');
    expect(await store.pending()).toEqual([]);
  });

  it('concurrent dispatch authorization can only send once', async () => {
    await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    const authorize = async () =>
      (await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now)) !== undefined;
    expect((await concurrent(authorize, authorize)).toSorted()).toEqual([false, true]);
    expect((await store.get(pending.settlement.settlementId)).status).toBe('SUBMITTING');
  });

  it('a shrunk manual batch restores the suffix and a stale worker cannot authorize the original membership', async () => {
    const first = await insert(1n, 'READY', after(60));
    const blocked = await insert(2n, 'READY', after(60));
    const tail = await insert(3n, 'READY', after(60));
    const original = await claimed('MANUAL');
    const id = original.settlement.settlementId;
    expect(
      await store.keepPrefix(
        id,
        [{ type: 'swap', requestId: first }],
        { type: 'swap', requestId: blocked },
        'MIN_OUT',
        'Minimum output',
        snapshot.version,
        now,
      ),
    ).toBe(true);
    expect(await status(first)).toBe('SETTLING');
    expect(await status(blocked)).toBe('BLOCKED');
    expect(await status(tail)).toBe('READY');
    expect(await store.authorizeDispatch(id, fills(original), snapshot, now)).toBeUndefined();
    const reduced = await store.pendingOf(scratch.db, id);
    expect(ids(reduced.settlement.requests)).toEqual([first]);
    expect(await store.authorizeDispatch(id, fills(reduced), snapshot, now)).toBeDefined();
  });

  it('disabling after dispatch does not prevent confirmation', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now);
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('AUTOMATIC');
    present(await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now));
    await store.updatePolicy('pool', 'swap', { automaticEnabled: false, batchSize: 1, expectedVersion: 1n }, now);
    await store.confirm(pending.settlement.settlementId, confirmation(pending));
    expect(await status(swap)).toBe('SETTLED');
    expect(await store.pending()).toEqual([]);
  });

  it('an uncertain submission retains the pool claim across a restart and the deadline', async () => {
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    present(await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now));
    await store.unresolved(pending.settlement.settlementId, now);
    const reopened = restarted();
    const inFlight = await workflowFailure(reopened.claim('pool', randomUUID(), 'MANUAL', snapshot, after(120)));
    expect(inFlight.message).toContain('in flight');
    const recovered = await reopened.pending();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.commandId).toBe(pending.commandId);
    expect(recovered[0]?.beginOffset).toBe(42n);
    expect(await status(swap)).toBe('SETTLING');
  });

  it('settlement recovery fences a late rejection and keeps the pool claimed', async () => {
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    const id = pending.settlement.settlementId;
    present(await store.authorizeDispatch(id, fills(pending), snapshot, now));
    expect(await store.beginRecovery(id, after(1))).toBe(true);
    await store.rejectSubmission(id, 'REJECTED', 'First submission rejected', after(2));
    expect((await store.get(id)).status).toBe('UNRESOLVED');
    expect(await status(swap)).toBe('SETTLING');
    const inFlight = await workflowFailure(store.claim('pool', randomUUID(), 'MANUAL', snapshot, after(3)));
    expect(inFlight.message).toContain('in flight');
    expect(await store.beginRecovery(id, after(4))).toBe(true);
    await store.confirm(id, confirmation(pending));
    expect((await store.get(id)).status).toBe('CONFIRMED');
    expect(await store.beginRecovery(id, after(5))).toBe(false);
  });

  it('a first settlement rejection prevents recovery and allows a new operation', async () => {
    await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    const id = pending.settlement.settlementId;
    present(await store.authorizeDispatch(id, fills(pending), snapshot, now));
    await store.rejectSubmission(id, 'REJECTED', 'First submission rejected', after(1));
    expect(await store.beginRecovery(id, after(2))).toBe(false);
    expect((await store.get(id)).status).toBe('REJECTED');
    const replacement = await claimed('MANUAL', after(3));
    expect(replacement.settlement.settlementId).not.toBe(id);
  });

  it('an excluded unknown batch preserves withdrawal evidence and releases the other requests', async () => {
    const withdrawn = await insert(1n, 'READY', after(60));
    const expired = await insert(2n, 'READY', after(10));
    const ready = await insert(3n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    const id = pending.settlement.settlementId;
    present(await store.authorizeDispatch(id, fills(pending), snapshot, now));
    await store.beginRecovery(id, after(1));
    await sql`UPDATE swap_requests SET status='WITHDRAWN' WHERE id=${withdrawn}`.execute(scratch.db);
    await setBlockedVersion('old-version');

    await store.excludeSubmission(id, 'BATCH_EXCLUDED', 'Ledger evidence excludes the batch', after(20));

    expect((await store.get(id)).status).toBe('REJECTED');
    expect((await store.get(id)).errorCode).toBe('BATCH_EXCLUDED');
    expect(await status(withdrawn)).toBe('WITHDRAWN');
    expect(await status(expired)).toBe('EXPIRED');
    expect(await status(ready)).toBe('READY');
    const { rows: released } = await sql<{ count: bigint }>`SELECT count(*) AS count FROM pool_queues q
      JOIN pool_request_queues r ON r.pool_id=q.pool_id WHERE q.pool_id='pool' AND r.family='swap'
      AND q.active_settlement_id IS NULL AND r.blocked_version IS NULL`.execute(scratch.db);
    expect(released).toEqual([{ count: 1n }]);
    expect(await allocations(expired)).toContain(LOCKED_ALLOCATION);

    const replacement = await claimed('MANUAL', after(21));
    expect(ids(replacement.settlement.requests)).toEqual([ready]);
    await setBlockedVersion('new-version');
    await store.excludeSubmission(id, 'STALE', 'Old exclusion delivered again', after(22));
    expect((await store.pending()).map((batch) => batch.settlement.settlementId)).toEqual([
      replacement.settlement.settlementId,
    ]);
    const { rows: active } = await sql<{ id: string }>`SELECT active_settlement_id AS id FROM pool_queues
      WHERE pool_id='pool'`.execute(scratch.db);
    expect(active).toEqual([{ id: replacement.settlement.settlementId }]);
    expect(await blockedVersion()).toBe('new-version');
    expect(await status(ready)).toBe('SETTLING');
    expect((await store.get(id)).errorCode).toBe('BATCH_EXCLUDED');
  });

  it('a stale exclusion cannot undo a confirmed settlement', async () => {
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    const id = pending.settlement.settlementId;
    present(await store.authorizeDispatch(id, fills(pending), snapshot, now));
    await store.confirm(id, confirmation(pending));
    const confirmed = await store.get(id);

    await store.excludeSubmission(id, 'STALE', 'Stale exclusion', after(1));

    expect(await store.get(id)).toEqual(confirmed);
    expect(await status(swap)).toBe('SETTLED');
  });

  it('an expired unconfirmed head still blocks confirmed followers', async () => {
    const head = await insert(1n, 'UNRESOLVED', after(-1));
    const follower = await insert(2n, 'READY', after(60));
    expect(await store.claim('pool', randomUUID(), 'MANUAL', snapshot, now)).toBeUndefined();
    expect(await status(head)).toBe('UNRESOLVED');
    expect(await status(follower)).toBe('READY');
  });

  it('a confirmed expired head is removed without discarding its locked allocation', async () => {
    const head = await insert(1n, 'BLOCKED', after(-1));
    const follower = await insert(2n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    expect(ids(pending.settlement.requests)).toEqual([follower]);
    expect(await status(head)).toBe('EXPIRED');
    expect(await allocations(head)).toContain(LOCKED_ALLOCATION);
  });

  it('automatic needs the exact threshold but manual can settle a smaller prefix', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 2, expectedVersion: 0n }, now);
    const swap = await insert(1n, 'READY', after(60));
    expect(await store.claim('pool', randomUUID(), 'AUTOMATIC', snapshot, now)).toBeUndefined();
    expect(ids((await claimed('MANUAL')).settlement.requests)).toEqual([swap]);
  });

  it('an unchanged snapshot cannot repeatedly submit a deterministically rejected batch', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now);
    await insert(1n, 'READY', after(60));
    const pending = await claimed('AUTOMATIC');
    present(await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now));
    await store.rejectSubmission(pending.settlement.settlementId, 'MIN_OUT', 'Output changed', now);
    expect(await store.claim('pool', randomUUID(), 'AUTOMATIC', snapshot, now)).toBeUndefined();
    const changed = poolSnapshot('version-2', 50n);
    expect(await store.claim('pool', randomUUID(), 'AUTOMATIC', changed, now)).toBeDefined();
  });

  it('a settlement confirmation wins a late withdrawal attempt', async () => {
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    present(await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now));
    await store.unresolved(pending.settlement.settlementId, now);
    await sql`UPDATE swap_requests SET status='WITHDRAWAL_UNRESOLVED' WHERE id=${swap}`.execute(scratch.db);
    await store.confirm(pending.settlement.settlementId, confirmation(pending));
    expect(await status(swap)).toBe('SETTLED');
    await store.confirm(pending.settlement.settlementId, confirmation(pending));
    expect((await store.get(pending.settlement.settlementId)).status).toBe('CONFIRMED');
  });

  it('contradictory terminal withdrawal evidence cannot be overwritten', async () => {
    const swap = await insert(1n, 'READY', after(60));
    const pending = await claimed('MANUAL');
    present(await store.authorizeDispatch(pending.settlement.settlementId, fills(pending), snapshot, now));
    await sql`UPDATE swap_requests SET status='WITHDRAWN' WHERE id=${swap}`.execute(scratch.db);
    await expect(store.confirm(pending.settlement.settlementId, confirmation(pending))).rejects.toThrow(
      'Conflicting terminal',
    );
    expect(await status(swap)).toBe('WITHDRAWN');
    expect((await store.get(pending.settlement.settlementId)).status).toBe('SUBMITTING');
  });

  it('independent families keep their own sequence and share only the settlement lock', async () => {
    await store.policy('pool', 'swap');
    const unknownSwap = await insert(1n, 'UNRESOLVED', after(600));
    const deposit = await insertLiquidity('DEPOSIT');
    const laterDeposit = await insertLiquidity('DEPOSIT');
    const withdrawal = await insertLiquidity('WITHDRAW');
    const laterWithdrawal = await insertLiquidity('WITHDRAW');
    expect(deposit.arrivalSequence).toBe(1n);
    expect(laterDeposit.arrivalSequence).toBe(2n);
    expect(withdrawal.arrivalSequence).toBe(1n);
    expect(laterWithdrawal.arrivalSequence).toBe(2n);

    const first = await claimed('MANUAL');
    expect(first.settlement.requests).toEqual([
      { type: 'deposit', requestId: deposit.requestId },
      { type: 'deposit', requestId: laterDeposit.requestId },
    ]);
    expect((await workflowFailure(store.claim('pool', randomUUID(), 'MANUAL', snapshot, now))).message).toContain(
      'in flight',
    );
    const depositFills: Fill[] = [deposit, laterDeposit].map((request) => ({
      requestId: request.requestId,
      actualBaseIn: '10',
      actualQuoteIn: '20',
      actualBaseRefund: '0',
      actualQuoteRefund: '5',
      actualLpOut: '10',
      type: 'deposit',
    }));
    present(await store.authorizeDispatch(first.settlement.settlementId, depositFills, snapshot, now));
    await store.unresolved(first.settlement.settlementId, now);
    const reopened = restarted();
    expect(present((await reopened.pending())[0]).requests.map(reference)).toEqual(first.settlement.requests);
    await reopened.confirm(first.settlement.settlementId, {
      fills: depositFills,
      before: reserves,
      after: reserves,
      updateId: 'deposit-update',
      offset: 44n,
      confirmedAt: instantText(now),
    });

    const second = await claimed('MANUAL', now, reopened);
    expect(second.settlement.requests).toEqual([
      { type: 'withdraw', requestId: withdrawal.requestId },
      { type: 'withdraw', requestId: laterWithdrawal.requestId },
    ]);
    const withdrawalFills: Fill[] = [withdrawal, laterWithdrawal].map((request) => ({
      requestId: request.requestId,
      actualLpBurned: '10',
      actualBaseOut: '5',
      actualQuoteOut: '10',
      type: 'withdraw',
    }));
    present(await reopened.authorizeDispatch(second.settlement.settlementId, withdrawalFills, snapshot, now));
    await reopened.unresolved(second.settlement.settlementId, now);
    const recovered = restarted();
    expect(present((await recovered.pending())[0]).requests.map(reference)).toEqual(second.settlement.requests);
    expect((await workflowFailure(recovered.claim('pool', randomUUID(), 'MANUAL', snapshot, now))).message).toContain(
      'in flight',
    );
    await recovered.confirm(second.settlement.settlementId, {
      fills: withdrawalFills,
      before: reserves,
      after: reserves,
      updateId: 'withdrawal-update',
      offset: 45n,
      confirmedAt: instantText(now),
    });
    expect(await status(unknownSwap)).toBe('UNRESOLVED');
    const liquidity = new LiquidityStore(scratch.db, 10);
    for (const request of [deposit, laterDeposit]) {
      const saved = await liquidity.get(request.requestId);
      expect(saved.status).toBe('SETTLED');
      expect(saved.result).toEqual({
        actualBaseIn: '10',
        actualQuoteIn: '20',
        actualBaseRefund: '0',
        actualQuoteRefund: '5',
        actualLpOut: '10',
      });
    }
    for (const request of [withdrawal, laterWithdrawal]) {
      const saved = await liquidity.get(request.requestId);
      expect(saved.status).toBe('SETTLED');
      expect(saved.result).toEqual({ actualLpBurned: '10', actualBaseOut: '5', actualQuoteOut: '10' });
    }
  });

  it('individual requests settle as singleton batches without changes to other requests or policies', async () => {
    for (const family of FAMILIES) {
      const first = await readyRequest(family, 1n);
      const chosen = await readyRequest(family, 2n);
      const policy = await store.policy('pool', family);
      const plan = await store.plan('pool', family, null, chosen.requestId, snapshot, now);
      expect(plan.selection.requests).toEqual([chosen]);
      const id = randomUUID();
      const batch = present(await store.claim('pool', id, 'MANUAL', snapshot, now, plan.selection));
      expect(batch.requests.map(reference)).toEqual([chosen]);
      expect((await workflowFailure(store.claim('pool', randomUUID(), 'MANUAL', snapshot, now))).message).toContain(
        'in flight',
      );
      const fill: Fill =
        family === 'swap'
          ? {
              requestId: chosen.requestId,
              amountOut: '18',
              outputInstrument: { admin: 'issuer', id: 'B' },
              type: 'swap',
            }
          : family === 'deposit'
            ? {
                requestId: chosen.requestId,
                actualBaseIn: '10',
                actualQuoteIn: '20',
                actualBaseRefund: '0',
                actualQuoteRefund: '5',
                actualLpOut: '10',
                type: 'deposit',
              }
            : {
                requestId: chosen.requestId,
                actualLpBurned: '1',
                actualBaseOut: '1',
                actualQuoteOut: '2',
                type: 'withdraw',
              };
      present(await store.authorizeDispatch(id, [fill], snapshot, now));
      await store.unresolved(id, now);
      const reopened = restarted();
      expect(present(await reopened.findIntent('pool', id, plan.selection)).requests).toEqual([chosen]);
      await reopened.confirm(id, {
        fills: [fill],
        before: reserves,
        after: reserves,
        updateId: `individual-${family}`,
        offset: 44n,
        confirmedAt: instantText(now),
      });
      expect((await reopened.get(id)).status).toBe('CONFIRMED');
      const queue = await reopened.queue('pool');
      const remaining = queue.filter((row) => sameRef(reference(row), first));
      expect(remaining.map((row) => row.request.status)).toEqual(['READY']);
      expect(queue.map(reference)).not.toContainEqual(chosen);
      expect({ ...(await reopened.policy('pool', family)), updatedAt: policy.updatedAt }).toEqual(policy);
    }
  });

  it('an individual selection rechecks eligibility and versions before the claim', async () => {
    for (const family of FAMILIES) {
      const chosen = await readyRequest(family, 1n);
      const plan = await store.plan('pool', family, null, chosen.requestId, snapshot, now);
      await store.setDeferred('pool', chosen, true, now);
      expect(await code(store.plan('pool', family, null, chosen.requestId, snapshot, now))).toBe(QUEUE_CHANGED);
      expect(await code(store.claim('pool', randomUUID(), 'MANUAL', snapshot, now, plan.selection))).toBe(
        QUEUE_CHANGED,
      );
      await store.setDeferred('pool', chosen, false, now);
      const changedState = selection(family, null, 'old-state', plan.selection.policyVersion, [chosen]);
      expect(await code(store.claim('pool', randomUUID(), 'MANUAL', snapshot, now, changedState))).toBe(POOL_CHANGED);
      await store.updatePolicy(
        'pool',
        family,
        { automaticEnabled: true, batchSize: 2, expectedVersion: plan.selection.policyVersion },
        now,
      );
      expect(await code(store.claim('pool', randomUUID(), 'MANUAL', snapshot, now, plan.selection))).toBe(
        POLICY_CHANGED,
      );
      const fresh = await store.plan('pool', family, null, chosen.requestId, snapshot, now);
      expect(await code(store.claim('pool', randomUUID(), 'MANUAL', snapshot, after(601), fresh.selection))).toBe(
        QUEUE_CHANGED,
      );
    }
    expect(await store.list('pool')).toEqual([]);
  });

  it('a rejected individual request behind the head does not block automatic settlement', async () => {
    await store.updatePolicy('pool', 'swap', { automaticEnabled: true, batchSize: 1, expectedVersion: 0n }, now);
    const head = await readyRequest('swap', 1n);
    const chosen = await readyRequest('swap', 2n);
    for (const submitted of [false, true]) {
      const plan = await store.plan('pool', 'swap', null, chosen.requestId, snapshot, now);
      const id = randomUUID();
      const batch = present(await store.claim('pool', id, 'MANUAL', snapshot, now, plan.selection));
      if (submitted) {
        present(await store.authorizeDispatch(id, fills(batch), snapshot, now));
        await store.rejectSubmission(id, 'MIN_OUT', 'Minimum not met', now);
      } else {
        await store.rejectPreparation(id, chosen, 'MIN_OUT', 'Minimum not met', snapshot.version, now);
      }
      const automatic = await claimed('AUTOMATIC');
      expect(automatic.settlement.requests).toEqual([head]);
      await store.cancelPreparation(automatic.settlement.settlementId, 'TEST', 'Release test batch', now);
    }
  });

  it('an individual preview requires the correct pool and family and cannot also retry a batch', async () => {
    const chosen = await readyRequest('swap', 1n);
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
      VALUES('other','c','s','p','Other')`.execute(scratch.db);
    expect(await code(store.plan('other', 'swap', null, chosen.requestId, snapshot, now))).toBe(QUEUE_CHANGED);
    expect(await code(store.plan('pool', 'deposit', null, chosen.requestId, snapshot, now))).toBe(QUEUE_CHANGED);
    await expect(store.plan('pool', 'swap', randomUUID(), chosen.requestId, snapshot, now)).rejects.toThrow(
      InvalidRequest,
    );
  });

  it('deferred requests keep their funds and return to their own queue tail', async () => {
    const first: RequestRef = { type: 'swap', requestId: await insert(1n, 'READY', after(600)) };
    const second: RequestRef = { type: 'swap', requestId: await insert(2n, 'READY', after(600)) };
    await store.plan('pool', 'swap', null, null, snapshot, now);
    await sql`UPDATE pool_request_queues SET next_sequence=2 WHERE pool_id='pool' AND family='swap'`.execute(
      scratch.db,
    );
    const references: RequestRef[] = [first];
    for (const kind of ['DEPOSIT', 'WITHDRAW'] as const) {
      const request = await insertLiquidity(kind);
      references.push({ type: kind === 'DEPOSIT' ? 'deposit' : 'withdraw', requestId: request.requestId });
    }
    for (const ref of references) {
      await store.setDeferred('pool', ref, true, now);
      await store.setDeferred('pool', ref, true, now);
      const row = await queued(store, ref);
      expect(row.deferred).toBe(true);
      expect(row.request.status).toBe('READY');
      expect((await store.plan('pool', ref.type, null, null, snapshot, now)).selection.requests).not.toContainEqual(
        ref,
      );
    }
    const reopened = restarted();
    expect((await reopened.queue('pool')).filter((row) => row.deferred)).toHaveLength(3);
    expect((await reopened.plan('pool', 'swap', null, null, snapshot, now)).selection.requests).toEqual([second]);
    for (const ref of references) {
      await reopened.setDeferred('pool', ref, false, now);
      const returned = await queued(reopened, ref);
      await reopened.setDeferred('pool', ref, false, now);
      expect((await queued(reopened, ref)).request.arrivalSequence).toBe(returned.request.arrivalSequence);
    }
    expect((await reopened.plan('pool', 'swap', null, null, snapshot, now)).selection.requests).toEqual([
      second,
      first,
    ]);
    await reopened.setDeferred('pool', first, true, now);
    await reopened.plan('pool', 'swap', null, null, snapshot, after(601));
    const expired = await queued(reopened, first);
    expect(expired.request.status).toBe('EXPIRED');
    expect(expired.deferred).toBe(true);
    expect(expired.request.allocationCids).toEqual([LOCKED_ALLOCATION]);
    await workflowFailure(reopened.setDeferred('pool', first, false, after(601)));
  });

  it('retries keep the rejected attempt and require the exact current preview', async () => {
    const first: RequestRef = { type: 'swap', requestId: await insert(1n, 'READY', after(600)) };
    const blocked: RequestRef = { type: 'swap', requestId: await insert(2n, 'READY', after(600)) };
    const last: RequestRef = { type: 'swap', requestId: await insert(3n, 'READY', after(600)) };
    const original = await store.plan('pool', 'swap', null, null, snapshot, now);
    const oldId = randomUUID();
    present(await store.claim('pool', oldId, 'MANUAL', snapshot, now, original.selection));
    await workflowFailure(store.setDeferred('pool', blocked, true, now));
    await workflowFailure(store.plan('pool', 'swap', oldId, null, snapshot, now));
    await store.rejectPreparation(oldId, blocked, 'MIN_OUT', 'Minimum not met', snapshot.version, now);
    const rejected = await store.get(oldId);
    await store.setDeferred('pool', blocked, true, now);
    const retry = await store.plan('pool', 'swap', oldId, null, snapshot, now);
    expect(retry.selection.requests).toEqual([first, last]);
    expect(await store.get(oldId)).toEqual(rejected);
    const newId = randomUUID();
    const wrongState = selection('swap', oldId, 'old-state', retry.selection.policyVersion, retry.selection.requests);
    await workflowFailure(store.claim('pool', newId, 'MANUAL', snapshot, now, wrongState));
    await store.setDeferred('pool', last, true, now);
    await workflowFailure(store.claim('pool', newId, 'MANUAL', snapshot, now, retry.selection));
    const refreshed = await store.plan('pool', 'swap', oldId, null, snapshot, now);
    const retried = present(await store.claim('pool', newId, 'MANUAL', snapshot, now, refreshed.selection));
    expect(retried.settlement.retryOf).toBe(oldId);
    expect(retried.settlement.requests).toEqual([first]);
    expect(await store.findIntent('pool', newId, refreshed.selection)).toEqual(retried.settlement);
    await workflowFailure(store.findIntent('pool', newId, retry.selection));
    present(await store.authorizeDispatch(newId, fills(retried), snapshot, now));
    await store.unresolved(newId, now);
    await workflowFailure(store.plan('pool', 'swap', newId, null, snapshot, now));
    await workflowFailure(store.setDeferred('pool', blocked, false, now));
    expect(await store.get(oldId)).toEqual(rejected);
  });

  it('a recovered preview cannot dispatch after the pool or policy changes', async () => {
    await insert(1n, 'READY', after(600));
    for (const changePool of [true, false]) {
      const chosen = (await store.plan('pool', 'swap', null, null, snapshot, now)).selection;
      const id = randomUUID();
      const batch = present(await store.claim('pool', id, 'MANUAL', snapshot, now, chosen));
      let observed = snapshot;
      if (changePool) {
        observed = poolSnapshot('changed-state', 43n);
      } else {
        await store.updatePolicy(
          'pool',
          'swap',
          { automaticEnabled: false, batchSize: 2, expectedVersion: chosen.policyVersion },
          now,
        );
      }
      const reopened = restarted();
      expect(await reopened.authorizeDispatch(id, fills(batch), observed, now)).toBeUndefined();
      expect((await reopened.get(id)).status).toBe('CANCELLED');
      expect((await reopened.get(id)).errorCode).toBe(changePool ? 'POOL_CHANGED' : 'POLICY_CHANGED');
      expect((await reopened.plan('pool', 'swap', null, null, snapshot, now)).selection.requests).toHaveLength(1);
    }
  });

  it('malformed public references do not mutate the queue', async () => {
    const withdrawal = await insertLiquidity('WITHDRAW');
    const refs: RequestRef[] = [
      { type: 'swap', requestId: randomUUID() },
      { type: 'deposit', requestId: withdrawal.requestId },
    ];
    for (const ref of refs) await expect(store.setDeferred('pool', ref, true, now)).rejects.toThrow(NotFound);
    expect((await store.queue('pool')).some((row) => row.deferred)).toBe(false);
    // A URL-safe cursor that keeps its Base64 padding must still decode.
    const invalid = Buffer.from(`not-a-date|${randomUUID()}`, 'utf8')
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
    await expect(store.history('pool', null, null, invalid, 25)).rejects.toThrow(InvalidRequest);
  });

  it('history pages through every attempt with stable filters', async () => {
    await insert(1n, 'READY', after(600));
    for (let n = 0; n < 5; n += 1) {
      const id = randomUUID();
      present(await store.claim('pool', id, 'MANUAL', snapshot, now));
      await store.cancelPreparation(id, 'PREFLIGHT_UNAVAILABLE', 'Unavailable', now);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await store.history('pool', 'swap', 'CANCELLED', cursor, 2);
      for (const batch of page.items) {
        expect(seen.has(batch.settlementId)).toBe(false);
        seen.add(batch.settlementId);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen.size).toBe(5);
    expect((await store.history('pool', 'withdraw', null, null, 2)).items).toEqual([]);
    expect((await store.history('another-pool', null, null, null, 2)).items).toEqual([]);
    expect((await store.history('pool', null, 'CONFIRMED', null, 2)).items).toEqual([]);
  });
});
