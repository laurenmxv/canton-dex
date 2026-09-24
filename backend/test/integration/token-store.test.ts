import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Conflict } from '../../src/platform/errors.js';
import type { Claim, Prepared } from '../../src/tokens/model.js';
import { TokenStore } from '../../src/tokens/store.js';
import { scenario } from './support/scenario.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_TOKEN_TEST_DATABASE_URL;

/** A preparation that expires in five minutes, at a millisecond that the database keeps exactly. */
function preparation(value: string): Prepared {
  return {
    preparedTransaction: `transaction-${value}`,
    preparedTransactionHash: `hash-${value}`,
    hashingSchemeVersion: 3,
    expiresAt: new Date(Math.floor(Date.now() / 1_000) * 1_000 + 300_123).toISOString(),
  };
}

/** Starts both operations before either completes; each runs on its own pooled connection. */
function concurrent<T>(first: () => Promise<T>, second: () => Promise<T>): Promise<[T, T]> {
  return Promise.all([first(), second()]);
}

function present(claim: Claim | undefined): Claim {
  if (!claim) throw new Error('No claim');
  return claim;
}

describe.runIf(scenario('swaps') && DATABASE_URL)('token store', () => {
  let scratch: ScratchDatabase;
  let store: TokenStore;
  const accountId = randomUUID();
  const partyId = `test-party-${randomUUID()}`;

  async function insertAccount(id: string): Promise<void> {
    await sql`INSERT INTO accounts(id,issuer,subject,display_name,role)
      VALUES(${id},'test',${id},'Trader','TRADER')`.execute(scratch.db);
  }

  async function claims(): Promise<bigint> {
    const { rows } = await sql<{ count: bigint }>`SELECT count(*) AS count FROM dev_faucet_claims`.execute(scratch.db);
    return rows[0]?.count ?? 0n;
  }

  async function current(): Promise<Claim> {
    return present(await store.get(accountId));
  }

  async function confirmGrant(): Promise<void> {
    await store.initialize(accountId, partyId);
    expect(await store.claimGrant(accountId, 10n)).toBe(true);
    await store.confirmGrant(accountId, (await current()).grantCommandId, {
      contractId: 'grant',
      updateId: 'grant-update',
    });
  }

  async function prepareClaim(): Promise<string> {
    await confirmGrant();
    const preparationId = randomUUID();
    expect(await store.savePreparation(accountId, preparationId, preparation('claim'))).toBe(true);
    return preparationId;
  }

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
    store = new TokenStore(scratch.db);
    await insertAccount(accountId);
  });

  afterEach(() => scratch.drop());

  it('concurrent initialization creates one durable grant identity', async () => {
    const [first, second] = await concurrent(
      () => store.initialize(accountId, partyId),
      () => store.initialize(accountId, partyId),
    );
    expect(first).toEqual(second);
    expect(await claims()).toBe(1n);
    const restarted = new TokenStore(scratch.reopen());
    expect(await restarted.initialize(accountId, partyId)).toEqual(first);
  });

  it('another account cannot create another grant for the same party', async () => {
    const original = await store.initialize(accountId, partyId);
    const anotherAccount = randomUUID();
    await insertAccount(anotherAccount);
    const failure = await store.initialize(anotherAccount, partyId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Conflict);
    expect(failure instanceof Error ? failure.message : '').toContain('already has a test token request');
    expect(await store.get(anotherAccount)).toBeUndefined();
    expect(await store.get(accountId)).toEqual(original);
    expect(await claims()).toBe(1n);
  });

  it('concurrent grant dispatch has one writer and preserves its attempt across a restart', async () => {
    const original = await store.initialize(accountId, partyId);
    const results = await concurrent(
      () => store.claimGrant(accountId, 101n),
      () => store.claimGrant(accountId, 102n),
    );
    expect([...results].sort()).toEqual([false, true]);
    const reserved = await current();
    expect(reserved.grantStatus).toBe('SUBMITTING');
    expect([101n, 102n]).toContain(reserved.grantBeginOffset);
    expect(reserved.grantId).toBe(original.grantId);
    expect(reserved.grantCommandId).not.toBe(original.grantCommandId);
    const restarted = new TokenStore(scratch.reopen());
    expect(await restarted.get(accountId)).toEqual(reserved);
    expect(await restarted.claimGrant(accountId, 200n)).toBe(false);
    await store.unresolvedGrant(accountId, reserved.grantCommandId);
    const unresolved = present(await restarted.get(accountId));
    expect(unresolved.grantStatus).toBe('UNRESOLVED');
    expect(unresolved.grantCommandId).toBe(reserved.grantCommandId);
    expect(unresolved.grantBeginOffset).toBe(reserved.grantBeginOffset);
    expect(await restarted.claimGrant(accountId, 300n)).toBe(false);
  });

  it('concurrent preparations cannot replace the winning fresh preparation', async () => {
    await confirmGrant();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = preparation('first');
    const second = preparation('second');
    const results = await concurrent(
      () => store.savePreparation(accountId, firstId, first),
      () => store.savePreparation(accountId, secondId, second),
    );
    expect([...results].sort()).toEqual([false, true]);
    const winner = await current();
    expect(winner.status).toBe('PREPARED');
    expect([firstId, secondId]).toContain(winner.preparationId);
    expect(winner.prepared).toEqual(winner.preparationId === firstId ? first : second);
    expect(await store.savePreparation(accountId, randomUUID(), preparation('replacement'))).toBe(false);
    expect(await store.get(accountId)).toEqual(winner);
  });

  it('an expired preparation can be refreshed, but its old id cannot submit', async () => {
    await confirmGrant();
    const expiredId = randomUUID();
    expect(await store.savePreparation(accountId, expiredId, preparation('expired'))).toBe(true);
    await sql`UPDATE dev_faucet_claims SET expires_at=now()-interval '1 second' WHERE account_id=${accountId}`.execute(
      scratch.db,
    );
    expect(await store.claimSubmission(accountId, expiredId, 100n)).toBe(false);
    const refreshedId = randomUUID();
    const refreshed = preparation('refreshed');
    expect(await store.savePreparation(accountId, refreshedId, refreshed)).toBe(true);
    expect(await store.claimSubmission(accountId, expiredId, 100n)).toBe(false);
    const saved = await current();
    expect(saved.preparationId).toBe(refreshedId);
    expect(saved.prepared).toEqual(refreshed);
    expect(saved.claimBeginOffset).toBeNull();
  });

  it('concurrent claim dispatch has one writer', async () => {
    const preparationId = await prepareClaim();
    expect(await store.claimSubmission(accountId, randomUUID(), 999n)).toBe(false);
    const results = await concurrent(
      () => store.claimSubmission(accountId, preparationId, 201n),
      () => store.claimSubmission(accountId, preparationId, 202n),
    );
    expect([...results].sort()).toEqual([false, true]);
    const reserved = await current();
    expect(reserved.status).toBe('SUBMITTING');
    expect([201n, 202n]).toContain(reserved.claimBeginOffset);
    expect(reserved.preparationId).toBe(preparationId);
    expect(await store.savePreparation(accountId, randomUUID(), preparation('late'))).toBe(false);
  });

  it('a restart preserves an uncertain claim without creating another grant or preparation', async () => {
    const preparationId = await prepareClaim();
    expect(await store.claimSubmission(accountId, preparationId, 300n)).toBe(true);
    await store.unresolved(accountId, preparationId);
    const saved = await current();
    const restarted = new TokenStore(scratch.reopen());
    expect(await restarted.initialize(accountId, partyId)).toEqual(saved);
    expect(await restarted.get(accountId)).toEqual(saved);
    expect(await restarted.claimGrant(accountId, 400n)).toBe(false);
    expect(await restarted.claimSubmission(accountId, preparationId, 400n)).toBe(false);
    expect(await restarted.savePreparation(accountId, randomUUID(), preparation('restart'))).toBe(false);
  });

  it('a completed claim cannot be reopened by late workers or a restart', async () => {
    const preparationId = await prepareClaim();
    expect(await store.claimSubmission(accountId, preparationId, 500n)).toBe(true);
    await store.complete(accountId, preparationId, { contractId: 'receipt', updateId: 'committed-update' });
    const completed = await current();
    await store.unresolved(accountId, preparationId);
    await store.rejected(accountId, preparationId);
    await store.unresolvedGrant(accountId, completed.grantCommandId);
    await store.rejectedGrant(accountId, completed.grantCommandId);
    await store.confirmGrant(accountId, completed.grantCommandId, {
      contractId: 'wrong-grant',
      updateId: 'wrong-update',
    });
    await store.complete(accountId, preparationId, { contractId: 'wrong-receipt', updateId: 'wrong-update' });
    expect(await store.claimSubmission(accountId, preparationId, 600n)).toBe(false);
    expect(await store.savePreparation(accountId, randomUUID(), preparation('late'))).toBe(false);
    const restarted = new TokenStore(scratch.reopen());
    expect(await restarted.initialize(accountId, partyId)).toEqual(completed);
    expect(await restarted.get(accountId)).toEqual(completed);
  });

  it('a stale grant recovery cannot reset or confirm a newer dispatch', async () => {
    await store.initialize(accountId, partyId);
    expect(await store.claimGrant(accountId, 100n)).toBe(true);
    const oldCommandId = (await current()).grantCommandId;
    await store.rejectedGrant(accountId, oldCommandId);
    expect(await store.claimGrant(accountId, 200n)).toBe(true);
    const latest = await current();
    expect(latest.grantCommandId).not.toBe(oldCommandId);
    await store.rejectedGrant(accountId, oldCommandId);
    await store.unresolvedGrant(accountId, oldCommandId);
    await store.confirmGrant(accountId, oldCommandId, { contractId: 'stale-grant', updateId: 'stale-update' });
    expect(await store.get(accountId)).toEqual(latest);
    expect(await store.claimGrant(accountId, 300n)).toBe(false);
  });

  it('a started grant recovery prevents a late initial rejection from reopening issuance', async () => {
    await store.initialize(accountId, partyId);
    expect(await store.claimGrant(accountId, 100n)).toBe(true);
    const commandId = (await current()).grantCommandId;
    expect(await store.beginGrantRecovery(accountId, commandId)).toBe(true);
    const recovering = await current();
    expect(recovering.grantStatus).toBe('UNRESOLVED');
    await store.rejectedGrant(accountId, commandId);
    expect(await store.get(accountId)).toEqual(recovering);
    expect(await store.claimGrant(accountId, 200n)).toBe(false);
    expect(await store.beginGrantRecovery(accountId, commandId)).toBe(true);
    expect((await current()).grantCommandId).toBe(commandId);
    await store.excludeGrant(accountId, commandId);
    expect((await current()).grantStatus).toBe('PENDING');
    expect(await store.claimGrant(accountId, 200n)).toBe(true);
    const replacement = await current();
    await store.excludeGrant(accountId, commandId);
    expect(await store.get(accountId)).toEqual(replacement);
  });

  it('an initial grant rejection prevents a stale recovery from dispatching', async () => {
    await store.initialize(accountId, partyId);
    expect(await store.claimGrant(accountId, 100n)).toBe(true);
    const commandId = (await current()).grantCommandId;
    await store.rejectedGrant(accountId, commandId);
    const rejected = await current();
    expect(rejected.grantStatus).toBe('PENDING');
    expect(await store.beginGrantRecovery(accountId, commandId)).toBe(false);
    expect(await store.get(accountId)).toEqual(rejected);
  });

  it('a stale claim recovery cannot reset or complete a newer preparation', async () => {
    const oldPreparationId = await prepareClaim();
    expect(await store.claimSubmission(accountId, oldPreparationId, 100n)).toBe(true);
    await store.rejected(accountId, oldPreparationId);
    const currentPreparationId = randomUUID();
    expect(await store.savePreparation(accountId, currentPreparationId, preparation('new-attempt'))).toBe(true);
    expect(await store.claimSubmission(accountId, currentPreparationId, 200n)).toBe(true);
    const latest = await current();
    await store.rejected(accountId, oldPreparationId);
    await store.unresolved(accountId, oldPreparationId);
    await store.complete(accountId, oldPreparationId, { contractId: 'stale-receipt', updateId: 'stale-update' });
    expect(await store.get(accountId)).toEqual(latest);
    expect(await store.savePreparation(accountId, randomUUID(), preparation('unexpected'))).toBe(false);
  });
});
