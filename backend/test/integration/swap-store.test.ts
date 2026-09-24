import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Account } from '../../src/iam/accounts.js';
import { Conflict, NotFound } from '../../src/platform/errors.js';
import { clockNanos, instantText } from '../../src/platform/time.js';
import type { Confirmation, Pending, Quote, SigningPayload, SwapStatus, Terms } from '../../src/swaps/model.js';
import { SwapRejected } from '../../src/swaps/ports.js';
import { SwapStore } from '../../src/swaps/store.js';
import { scenario } from './support/scenario.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_SETTLEMENT_TEST_DATABASE_URL;
const SECOND = 1_000_000_000n;
const MICROSECOND = 1_000n;

/** Starts both operations before either completes; each runs on its own pooled connection. */
function concurrent<T>(first: () => Promise<T>, second: () => Promise<T>): Promise<[T, T]> {
  return Promise.all([first(), second()]);
}

describe.runIf(scenario('swaps') && DATABASE_URL)('swap store', () => {
  const trader: Account = {
    id: randomUUID(),
    issuer: 'test',
    subject: 'trader',
    displayName: 'Trader',
    role: 'TRADER',
  };
  const now = (clockNanos() / MICROSECOND) * MICROSECOND;
  let scratch: ScratchDatabase;
  let store: SwapStore;

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
    store = new SwapStore(scratch.db, 10);
    await sql`INSERT INTO accounts(id,issuer,subject,display_name,role)
      VALUES(${trader.id},'test','trader','Trader','TRADER')`.execute(scratch.db);
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
      VALUES('pool','config','state','package','Pool')`.execute(scratch.db);
  });

  afterEach(() => scratch.drop());

  function signing(): SigningPayload {
    return {
      preparedTransaction: 'opaque-transaction',
      preparedTransactionHash: Buffer.alloc(32).toString('base64'),
      hashingSchemeVersion: 2,
      partyId: 'trader::namespace',
      publicKeyFingerprint: 'wallet-key-fingerprint',
      expiresAt: instantText(now + 120n * SECOND),
    };
  }

  async function quote(deadline: bigint): Promise<Quote> {
    const value: Quote = {
      quoteId: randomUUID(),
      poolId: 'pool',
      poolName: 'BTC/USDC',
      trader: 'trader::namespace',
      direction: 'BaseToQuote',
      inputInstrument: { admin: 'issuer', id: 'BTC' },
      outputInstrument: { admin: 'issuer', id: 'USDC' },
      amountIn: '0.00000001',
      expectedOut: '0.000099',
      feeAmount: '0',
      minOut: '0.00009',
      slippageBps: 100,
      stateId: 'state',
      quoteExpiresAt: instantText(now + 30n * SECOND),
      settlementDeadline: instantText(deadline),
    };
    await store.saveQuote(value, trader);
    return value;
  }

  function save(value: Quote): Promise<Pending> {
    const swapId = randomUUID();
    const terms: Terms = {
      poolId: value.poolId,
      poolName: value.poolName,
      trader: value.trader,
      direction: value.direction,
      inputInstrument: value.inputInstrument,
      outputInstrument: value.outputInstrument,
      amountIn: value.amountIn,
      expectedOut: value.expectedOut,
      feeAmount: value.feeAmount,
      minOut: value.minOut,
      settlementDeadline: value.settlementDeadline,
    };
    return store.savePreparation(swapId, randomUUID(), swapId, value.quoteId, trader, terms, signing());
  }

  function evidence(pending: Pending, status: SwapStatus): Confirmation {
    const id = pending.swap.swapId;
    return {
      status,
      allocationCids: [`input-${id}`, `output-${id}`],
      amountOut: status === 'SETTLED' ? '0.000099' : null,
      updateId: `update-${status}`,
      offset: 43n,
      confirmedAt: instantText(now),
    };
  }

  async function count(table: 'swap_requests' | 'swap_preparations'): Promise<bigint> {
    const { rows } = await sql<{ count: bigint }>`SELECT count(*) AS count FROM ${sql.table(table)}`.execute(
      scratch.db,
    );
    return rows[0]?.count ?? 0n;
  }

  async function queueColumn(column: 'next_sequence' | 'batch_size' | 'blocked_version'): Promise<unknown> {
    const { rows } = await sql<{ value: unknown }>`SELECT ${sql.ref(column)} AS value FROM pool_request_queues
      WHERE pool_id='pool' AND family='swap'`.execute(scratch.db);
    return rows[0]?.value;
  }

  async function preparationStatus(id: string): Promise<string | undefined> {
    const { rows } = await sql<{ status: string }>`SELECT status FROM swap_preparations WHERE id=${id}`.execute(
      scratch.db,
    );
    return rows[0]?.status;
  }

  it('a persisted quote and preparation round trip without losing the wallet identity or decimal terms', async () => {
    const value = await quote(now + 300n * SECOND);
    expect(await store.quote(value.quoteId, trader)).toEqual(value);
    const preparation = await save(value);
    const restarted = new SwapStore(scratch.reopen(), 10);
    const loaded = await restarted.pendingOwned(preparation.preparationId, trader);
    expect(loaded).toEqual(preparation);
    expect(loaded.signing).toEqual(signing());
    expect(loaded.accountId).toBe(trader.id);
    expect(loaded.swap.amountIn).toBe('0.00000001');
    expect(loaded.swap.minOut).toBe('0.00009');
    expect(loaded.swap.settlementDeadline).toBe(value.settlementDeadline);
    expect(await restarted.preparedQuote(value.quoteId, trader)).toEqual(loaded);
    const other: Account = { id: randomUUID(), issuer: 'test', subject: 'other', displayName: 'Other', role: 'TRADER' };
    await expect(restarted.pendingOwned(preparation.preparationId, other)).rejects.toThrow(NotFound);
  });

  it('racing preparations for one quote return the same durable transaction', async () => {
    const value = await quote(now + 300n * SECOND);
    const [first, second] = await concurrent(
      () => save(value),
      () => save(value),
    );
    expect(first.preparationId).toBe(second.preparationId);
    expect(first.swap.swapId).toBe(second.swap.swapId);
    expect(first.commandId).toBe(second.commandId);
    expect(await count('swap_requests')).toBe(1n);
    expect(await count('swap_preparations')).toBe(1n);
  });

  it('concurrent submission claims allocate exactly one queue sequence', async () => {
    const preparation = await save(await quote(now + 300n * SECOND));
    const begin = () => store.begin(preparation.preparationId, trader, 'signature', 42n, now);
    expect((await concurrent(begin, begin)).toSorted()).toEqual([false, true]);
    const submitted = await store.pendingOwned(preparation.preparationId, trader);
    expect(submitted.signature).toBe('signature');
    expect(submitted.beginOffset).toBe(42n);
    expect(submitted.swap.arrivalSequence).toBe(1n);
    expect(submitted.swap.status).toBe('SUBMITTING');
    expect(await queueColumn('next_sequence')).toBe(1n);
  });

  it('a changed signature cannot replace an uncertain submission', async () => {
    const preparation = await save(await quote(now + 300n * SECOND));
    await store.begin(preparation.preparationId, trader, 'original', 42n, now);
    await store.uncertain(preparation.preparationId);
    const failure = await store
      .begin(preparation.preparationId, trader, 'replacement', 50n, now)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Conflict);
    expect(failure instanceof Conflict ? failure.code : undefined).toBe('IDEMPOTENCY_CONFLICT');
    const pending = await store.pendingOwned(preparation.preparationId, trader);
    expect(pending.signature).toBe('original');
    expect(pending.beginOffset).toBe(42n);
    expect(pending.swap.arrivalSequence).toBe(1n);
    expect(pending.swap.status).toBe('UNRESOLVED');
  });

  it('a racing lost response and ledger confirmation always leave the confirmed ready state', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const preparation = await save(await quote(now + 300n * SECOND));
      await store.begin(preparation.preparationId, trader, 'signature', 42n, now);
      await concurrent(
        () => store.uncertain(preparation.preparationId),
        () => store.confirm(preparation.preparationId, evidence(preparation, 'READY')),
      );
      expect((await store.get(preparation.swap.swapId)).status).toBe('READY');
      expect(await preparationStatus(preparation.preparationId)).toBe('CONFIRMED');
    }
    expect(await store.unresolved()).toEqual([]);
  });

  it('confirming a later arrival does not retry the unchanged blocked head', async () => {
    const head = await save(await quote(now + 300n * SECOND));
    await store.begin(head.preparationId, trader, 'head-signature', 42n, now);
    await store.confirm(head.preparationId, evidence(head, 'READY'));
    await sql`UPDATE swap_requests SET status='BLOCKED',error_code='MIN_OUT' WHERE id=${head.swap.swapId}`.execute(
      scratch.db,
    );
    await sql`UPDATE pool_request_queues SET blocked_version='same-pool-state'
      WHERE pool_id='pool' AND family='swap'`.execute(scratch.db);
    const follower = await save(await quote(now + 300n * SECOND));
    await store.begin(follower.preparationId, trader, 'follower-signature', 50n, now);
    await store.confirm(follower.preparationId, evidence(follower, 'READY'));
    expect(await queueColumn('blocked_version')).toBe('same-pool-state');
    expect((await store.get(head.swap.swapId)).status).toBe('BLOCKED');
    expect((await store.get(follower.swap.swapId)).status).toBe('READY');
  });

  it('the first trader submission respects the configured maximum batch size', async () => {
    store = new SwapStore(scratch.db, 2);
    const preparation = await save(await quote(now + 300n * SECOND));
    await store.begin(preparation.preparationId, trader, 'signature', 42n, now);
    expect(await queueColumn('batch_size')).toBe(2);
  });

  it('a definitively rejected withdrawal allows a new preparation without replay of the old one', async () => {
    const preparation = await save(await quote(now - SECOND));
    await store.begin(preparation.preparationId, trader, 'signature', 42n, now - 60n * SECOND);
    await store.confirm(preparation.preparationId, evidence(preparation, 'READY'));
    const swapId = preparation.swap.swapId;
    const withdrawal = await store.saveWithdrawal(swapId, randomUUID(), randomUUID(), trader, signing(), now);
    expect(await store.begin(withdrawal.preparationId, trader, 'withdraw-signature', 50n, now)).toBe(true);
    expect((await store.pending(withdrawal.preparationId)).beginOffset).toBe(42n);
    await store.rejected(withdrawal.preparationId, new SwapRejected('INVALID_SIGNATURE', 'Rejected'));
    expect((await store.get(swapId)).status).toBe('EXPIRED');
    expect((await store.get(swapId)).canWithdraw).toBe(true);
    expect(await store.latestWithdrawal(swapId, trader)).toBeUndefined();
    expect(await store.begin(withdrawal.preparationId, trader, 'withdraw-signature', 50n, now)).toBe(false);

    const retry = await store.saveWithdrawal(swapId, randomUUID(), randomUUID(), trader, signing(), now);
    expect(retry.preparationId).not.toBe(withdrawal.preparationId);
    expect(await store.begin(retry.preparationId, trader, 'retry-signature', 55n, now)).toBe(true);
    expect((await store.pending(retry.preparationId)).beginOffset).toBe(42n);
    await store.confirm(retry.preparationId, evidence(preparation, 'WITHDRAWN'));
    expect((await store.get(swapId)).status).toBe('WITHDRAWN');
    expect((await store.get(swapId)).canWithdraw).toBe(false);
  });

  it('a late initial confirmation cannot regress either terminal outcome', async () => {
    const terminals: SwapStatus[] = ['SETTLED', 'WITHDRAWN'];
    for (const terminal of terminals) {
      const preparation = await save(await quote(now + 300n * SECOND));
      await store.begin(preparation.preparationId, trader, 'signature', 42n, now);
      await store.confirm(preparation.preparationId, evidence(preparation, 'READY'));
      await store.confirm(preparation.preparationId, evidence(preparation, terminal));
      await store.confirm(preparation.preparationId, evidence(preparation, 'READY'));
      const swap = await store.get(preparation.swap.swapId);
      expect(swap.status).toBe(terminal);
      expect(swap.updateId).toBe(`update-${terminal}`);
      expect(swap.canWithdraw).toBe(false);
      expect(await preparationStatus(preparation.preparationId)).toBe('CONFIRMED');
    }
  });
});
