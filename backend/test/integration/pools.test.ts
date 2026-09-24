import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureClientSecret } from '../../src/bootstrap/keycloak.js';
import { ServiceCredentials } from '../../src/canton/credentials.js';
import { created, createdEvents, exercise, Ledger, type DisclosedContract } from '../../src/canton/ledger.js';
import { Pool, PoolFactory, PoolProposal } from '../../src/canton/packages.js';
import { CantonPoolLedger } from '../../src/canton/pool-ledger.js';
import { CantonTokenRegistry } from '../../src/canton/token-registry.js';
import type { Account } from '../../src/iam/accounts.js';
import { epochNanos } from '../../src/platform/time.js';
import type { CreateProposal } from '../../src/pools/model.js';
import { PoolRejected, type PoolLedger } from '../../src/pools/ports.js';
import { PoolStore } from '../../src/pools/store.js';
import { PoolWorkflow } from '../../src/pools/workflow.js';
import type { Instrument } from '../../src/tokens/model.js';
import { TokenRegistryStore } from '../../src/tokens/registry-store.js';
import { at, text } from '../support/json.js';
import { delay, withBackend, type BackendFixture } from './support/backend.js';
import { decidePool } from './support/decide-pool.js';
import { DevelopmentFixtures } from './support/fixtures.js';
import { scenario } from './support/scenario.js';

const ROOT = '/v1/admin/pool-proposals';
const STATUS_TIMEOUT_MS = 45_000;
const STATUS_POLL_MS = 500;
const SILENT_LOG = { info: () => undefined, warn: () => undefined };

describe.runIf(scenario('pools'))('pool creation', () => {
  /** Every instrument a test registered, removed again once it ends. */
  const registered: Instrument[] = [];

  afterEach(async () => {
    const fixtures = new DevelopmentFixtures();
    try {
      for (const instrument of registered.splice(0)) {
        await fixtures.db
          .deleteFrom('token_instruments')
          .where('admin', '=', instrument.admin)
          .where('instrument_id', '=', instrument.id)
          .execute();
      }
    } finally {
      await fixtures.close();
    }
  });

  /**
   * A proposal over a pair this registers first. Only a registered instrument may be proposed,
   * and every pair the venue already carries is claimed for good, so each run registers its own
   * pair under an administrator that already runs a token registry. The administrator comes from
   * the registry table rather than the offered catalog, and the insert has no conflict clause, so
   * a pair that already exists fails here instead of being adopted and then deleted.
   */
  async function input(test: BackendFixture, suffix: string): Promise<CreateProposal> {
    const registry = await test.fixtures.db
      .selectFrom('token_registries')
      .select('admin')
      .orderBy('admin')
      .limit(1)
      .executeTakeFirst();
    if (!registry) throw new Error('No token registry is configured; run the bootstrap first');
    const base = `BASE-${suffix}`;
    const quote = `QUOTE-${suffix}`;
    for (const id of [base, quote]) {
      await test.fixtures.db
        .insertInto('token_instruments')
        .values({ admin: registry.admin, instrument_id: id, symbol: id, decimals: 6 })
        .execute();
      registered.push({ admin: registry.admin, id });
    }
    return {
      name: `Pool ${suffix}`,
      baseInstrumentId: { admin: registry.admin, id: base },
      quoteInstrumentId: { admin: registry.admin, id: quote },
      feeBps: '30',
    };
  }

  async function status(test: BackendFixture, token: string, id: string, expected: string): Promise<unknown> {
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    for (;;) {
      const proposal = await test.request('GET', `${ROOT}/${id}`, token, undefined, 200);
      if (at(proposal, 'status') === expected) return proposal;
      if (Date.now() > deadline) throw new Error(`Proposal did not become ${expected}: ${JSON.stringify(proposal)}`);
      await delay(STATUS_POLL_MS);
    }
  }

  async function health(test: BackendFixture, token: string, poolId: string): Promise<unknown> {
    return at(
      await test.request('GET', `/v1/admin/monitoring?poolId=${poolId}`, token, undefined, 200),
      'pool',
      'health',
    );
  }

  /** The DVO accepts the proposal directly, so no settlement delegation is created. */
  async function acceptWithoutDelegation(test: BackendFixture, proposalCid: string, data: CreateProposal) {
    const { fixtures } = test;
    const actor = await fixtures.db
      .selectFrom('fixture_parties')
      .selectAll()
      .where('name', '=', 'dvo')
      .executeTakeFirstOrThrow();
    const dvo = Ledger.service(
      fixtures.http,
      new ServiceCredentials(fixtures.config.ledgerTokenUrl, {
        userId: actor.ledger_user_id,
        clientId: actor.ledger_client_id,
        clientSecret: process.env.DEX_DVO_CLIENT_SECRET ?? fixtureClientSecret('dvo'),
      }),
    );
    const registry = new CantonTokenRegistry(new TokenRegistryStore(fixtures.db));
    const disclosures = new Map<string, DisclosedContract>();
    for (const issuer of new Set([actor.party_id, data.baseInstrumentId.admin, data.quoteInstrumentId.admin])) {
      for (const operation of [await registry.inlineAllocation(issuer), await registry.inlineSettlement(issuer)]) {
        for (const disclosure of operation.disclosures) disclosures.set(disclosure.contractId, disclosure);
      }
    }
    await dvo.submit(
      `accept-without-delegation-${randomUUID()}`,
      await dvo.primaryParty(),
      [],
      [exercise(PoolProposal, proposalCid, 'PoolProposal_Accept', { initialRatio: '2' })],
      [...disclosures.values()],
    );
  }

  it('accepts a real proposal with recovery and authority separation', () =>
    withBackend(async (test) => {
      const operator = test.fixtures.operatorLedger();
      const operatorParty = await operator.primaryParty();
      const token = await test.token('operator');
      const trader = await test.token(await test.trader('pool-forbidden'));
      await test.request('GET', ROOT, trader, undefined, 403);
      const options = await test.request('GET', `${ROOT}/options`, token, undefined, 200);
      const data = await input(test, randomUUID().slice(0, 8));
      await test.request('POST', ROOT, trader, data, 403);
      const proposal = await test.request('POST', ROOT, token, data, 202);
      const id = text(proposal, 'proposalId');
      const pending = await status(test, token, id, 'PENDING');
      const cid = text(pending, 'proposalCid');
      const reversed = { ...data, baseInstrumentId: data.quoteInstrumentId, quoteInstrumentId: data.baseInstrumentId };
      await test.request('POST', ROOT, token, reversed, 409);
      await expect(
        operator.submit(
          `forbidden-${randomUUID()}`,
          operatorParty,
          [],
          [exercise(PoolProposal, cid, 'PoolProposal_Accept', { initialRatio: '2' })],
        ),
      ).rejects.toThrow();
      // Simulate a lost proposal response; only this test's record is changed.
      await sql`UPDATE pool_proposals SET proposal_cid=NULL,status='UNRESOLVED',update_id=NULL WHERE id=${id}`.execute(
        test.fixtures.db,
      );
      expect(text(await status(test, token, id, 'PENDING'), 'proposalCid')).toBe(cid);
      await acceptWithoutDelegation(test, cid, data);
      const result = await status(test, token, id, 'CREATED');
      const poolId = text(result, 'poolId');
      expect(await health(test, token, poolId)).toBe('DELEGATION_MISSING');
      await decidePool('accept', id, '2');
      expect(await health(test, token, poolId)).toBe('EMPTY');
      const detail = await test.request('GET', `/v1/pools/${poolId}`, token, undefined, 200);
      await test.request('GET', `/v1/pools/${poolId}`, trader, undefined, 200);
      expect(text(detail, 'settings', 'baseReserve')).toBe('0.0000000000');
      const row = await test.fixtures.db
        .selectFrom('pools')
        .select(['config_id', 'state_id'])
        .where('pool_id', '=', poolId)
        .executeTakeFirstOrThrow();
      expect(row.config_id).toBe(text(detail, 'configId'));
      expect(row.state_id).toBe(text(detail, 'stateId'));
      expect(
        (await operator.activeContracts(operatorParty, PoolProposal)).map((event) => event.contractId),
      ).not.toContain(cid);
      expect((await operator.activeContracts(operatorParty, Pool)).map((event) => event.contractId)).toContain(poolId);
      const tx = (await operator.transactions(0n, operatorParty)).find(
        (candidate) => candidate.updateId === text(result, 'updateId'),
      );
      if (!tx) throw new Error('The acceptance transaction is not in the operator history');
      expect(createdEvents(tx).filter((event) => event.templateId.split(':')[1] === 'Pool')).toHaveLength(3);
      expect(epochNanos(text(detail, 'createdAt'))).toBe(epochNanos(created(tx, Pool).createdAt));
      expect((await operator.activeContracts(operatorParty, PoolFactory)).map((event) => event.contractId)).toContain(
        text(options, 'factoryId'),
      );
      const before = await operator.ledgerEnd();
      await decidePool('accept', id, '2');
      expect(await operator.ledgerEnd()).toBe(before);
      // Replay evidence after a lost final database confirmation, never another ledger write.
      await sql`UPDATE pool_proposals SET status='UNRESOLVED',pool_id=NULL WHERE id=${id}`.execute(test.fixtures.db);
      expect(text(await status(test, token, id, 'CREATED'), 'poolId')).toBe(poolId);
      await test.request('POST', ROOT, token, data, 409);
      await test.request('POST', `${ROOT}/${id}/withdraw`, token, {}, 409);
      expect(JSON.stringify(await test.request('GET', '/v1/pools', token, undefined, 200))).toContain(poolId);
      console.log(
        'PASS pool acceptance: API/Postgres/Canton CIDs match; exact three creates; operator forbidden; uncertainty reconciled; missing delegation repaired; replay creates nothing.',
      );
    }));

  it('a definitive failure releases the database reservation and a withdrawal remains retryable', () =>
    withBackend(async (test) => {
      const token = await test.token('operator');
      await test.request('GET', `${ROOT}/options`, token, undefined, 200);
      const data = await input(test, randomUUID().slice(0, 8));
      const { db } = test.fixtures;
      const registry = new TokenRegistryStore(db);
      const delegate = new CantonPoolLedger(
        test.fixtures.operatorLedger(),
        registry,
        new CantonTokenRegistry(registry),
      );
      let rejected = true;
      const injected = () => Promise.reject(new PoolRejected(new Error('Injected definitive rejection')));
      const ledger: PoolLedger = {
        packageId: delegate.packageId,
        operator: () => delegate.operator(),
        offset: () => delegate.offset(),
        factory: (dvo) => delegate.factory(dvo),
        pools: (names, dvo) => delegate.pools(names, dvo),
        propose: (proposal, commandId) => (rejected ? injected() : delegate.propose(proposal, commandId)),
        withdraw: (proposal, commandId) => (rejected ? injected() : delegate.withdraw(proposal, commandId)),
        recover: (pending) => delegate.recover(pending),
      };
      const workflow = new PoolWorkflow(new PoolStore(db), ledger, registry, SILENT_LOG);
      const account = await db
        .selectFrom('accounts')
        .select('id')
        .where('role', '=', 'OPERATOR')
        .limit(1)
        .executeTakeFirstOrThrow();
      const actor: Account = {
        id: account.id,
        issuer: 'issuer',
        subject: 'operator',
        displayName: 'Operator',
        role: 'OPERATOR',
      };
      const failed = await workflow.create(data, actor);
      expect(failed.status).toBe('FAILED');
      const { rows } = await sql<{ count: bigint }>`
        SELECT count(*) AS count FROM pool_pair_claims WHERE proposal_id=${failed.proposalId}`.execute(db);
      expect(rows).toEqual([{ count: 0n }]);
      rejected = false;
      const pending = await workflow.create(data, actor);
      expect(pending.status).toBe('PENDING');
      rejected = true;
      const retryable = await workflow.withdraw(pending.proposalId, actor);
      expect(retryable.status).toBe('PENDING');
      expect(retryable.error).toMatch(/\S/);
      rejected = false;
      expect((await workflow.withdraw(pending.proposalId, actor)).status).toBe('WITHDRAWN');
    }));

  it('rejects, withdraws and guards a concurrent pair reservation', () =>
    withBackend(async (test) => {
      const token = await test.token('operator');
      await test.request('GET', `${ROOT}/options`, token, undefined, 200);
      const data = await input(test, randomUUID().slice(0, 8));
      const proposal = await test.request('POST', ROOT, token, data, 202);
      const id = text(proposal, 'proposalId');
      await status(test, token, id, 'PENDING');
      await decidePool('reject', id);
      expect(at(await status(test, token, id, 'REJECTED'), 'poolId')).toBeNull();
      const next = await test.request('POST', ROOT, token, data, 202);
      const nextId = text(next, 'proposalId');
      await status(test, token, nextId, 'PENDING');
      await test.request('POST', `${ROOT}/${nextId}/withdraw`, token, {}, 202);
      await status(test, token, nextId, 'WITHDRAWN');
      await test.request('POST', `${ROOT}/${nextId}/withdraw`, token, {}, 202);
      const responses = await Promise.all([test.send('POST', ROOT, token, data), test.send('POST', ROOT, token, data)]);
      await Promise.all(responses.map((response) => response.text()));
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      const bad = { ...(await input(test, randomUUID())), feeBps: '10000' };
      await test.request('POST', ROOT, token, bad, 400);
      await test.request('POST', ROOT, token, { ...bad, feeBps: '30', quoteInstrumentId: bad.baseInstrumentId }, 400);
      console.log(
        'PASS reject/withdraw: no pools, pair released; concurrent duplicate guarded; invalid quantities rejected.',
      );
    }));
});
