import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../src/canton/contracts.js';
import { DEX_PACKAGE_ID, packageOf, Pool } from '../../src/canton/packages.js';
import { numericUnits } from '../../src/platform/decimal.js';
import { DevelopmentFixtures } from './support/fixtures.js';
import { at } from '../support/json.js';
import { backing, poolCatalog } from './support/pool-ledger.js';
import { scenario } from './support/scenario.js';

describe.runIf(scenario('environment'))('environment', () => {
  const fixtures = new DevelopmentFixtures();
  afterAll(() => fixtures.close());

  it('has the actual infrastructure and contracts ready', async () => {
    const ledger = fixtures.operatorLedger();
    const tables = await sql<{ table_name: string }>`
      SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema()`.execute(fixtures.db);
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'accounts',
        'fixture_parties',
        'pools',
        'onboardings',
        'onboarding_steps',
        'venue_configuration',
        'pool_proposals',
        'pool_pair_claims',
      ]),
    );
    const discovery = await fixtures.keycloakDiscovery();
    expect(discovery.status).toBe(200);
    expect(await discovery.text()).toContain(fixtures.config.issuer);
    expect(await ledger.ledgerEnd()).toBeGreaterThan(0);
    expect(await ledger.connected()).toBe(true);
    const runtimeRights = await fixtures.admin.rights(fixtures.config.operator.userId);
    expect(
      runtimeRights.some(
        (right) =>
          at(right, 'kind', 'ParticipantAdmin') !== undefined ||
          at(right, 'kind', 'CanReadAsAnyParty') !== undefined ||
          at(right, 'kind', 'CanExecuteAsAnyParty') !== undefined,
      ),
    ).toBe(false);
    expect(await ledger.hasPackage(DEX_PACKAGE_ID)).toBe(true);
    const { party_id: authority } = await fixtures.db
      .selectFrom('fixture_parties')
      .select('party_id')
      .where('name', '=', 'dvo')
      .executeTakeFirstOrThrow();
    const operator = await ledger.primaryParty();
    const actAs = runtimeRights.flatMap((right) => {
      const party = at(right, 'kind', 'CanActAs', 'value', 'party');
      return typeof party === 'string' ? [party] : [];
    });
    expect(actAs).toEqual([operator]);
    const rows = await sql<{ pool_id: string; package_id: string; pair: string }>`
      SELECT p.*, t.pair FROM test_token_pools t JOIN pools p ON p.pool_id=t.pool_id
      WHERE p.active ORDER BY t.pair`.execute(fixtures.db);
    expect(rows.rows.map((row) => row.pair)).toEqual(['BTC/USDC', 'ETH/USDC']);
    const catalog = await poolCatalog(ledger, authority);
    const events = await ledger.activeContracts(operator, Pool);
    const { issuer_party_id: issuer } = await fixtures.db
      .selectFrom('test_token_configuration')
      .select('issuer_party_id')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const readAs = runtimeRights.flatMap((right) => {
      const party = at(right, 'kind', 'CanReadAs', 'value', 'party');
      return typeof party === 'string' ? [party] : [];
    });
    expect(readAs).toContain(authority);
    expect(readAs).not.toContain(issuer);
    for (const row of rows.rows) {
      const event = events.find((candidate) => candidate.contractId === row.pool_id);
      if (!event) throw new Error(`Pool ${row.pool_id} is not active`);
      const sourcePackage = packageOf(event.templateId);
      expect(sourcePackage).toBe(DEX_PACKAGE_ID);
      expect(row.package_id).toBe(sourcePackage);
      const value = pool(event.createArgument);
      expect(value.dvo).toBe(authority);
      expect(value.venueOperator).toBe(operator);
      expect(event.signatories).toEqual([authority]);
      expect(event.observers).toContain(operator);
      expect(value.lpToken.instrument.admin).toBe(authority);
      expect(value.baseAccount.owner).toBe(authority);
      expect(value.quoteAccount.owner).toBe(authority);
      expect(value.baseAccount.provider).toBe(operator);
      expect(value.quoteAccount.provider).toBe(operator);
      expect(value.baseAccount.id.trim()).not.toBe('');
      expect(value.baseAccount.id).not.toBe(value.quoteAccount.id);
      expect(value.baseToken.instrument.admin).toBe(issuer);
      expect(value.quoteToken.instrument.admin).toBe(issuer);
      expect(`${value.baseToken.instrument.id}/${value.quoteToken.instrument.id}`).toBe(row.pair);
      const detail = catalog.find((candidate) => candidate.poolId === row.pool_id);
      if (!detail) throw new Error(`Pool ${row.pool_id} is missing from the catalog`);
      expect(detail.packageId).toBe(sourcePackage);
      expect(detail.settings.dvo).toBe(authority);
      expect(numericUnits(detail.settings.baseReserve)).toBeGreaterThan(0n);
      expect(numericUnits(detail.settings.quoteReserve)).toBeGreaterThan(0n);
      expect(numericUnits(detail.settings.lpTokenSupply)).toBeGreaterThan(0n);
      await backing(ledger, row.pool_id);
    }
    console.log(
      'PASS environment: real PostgreSQL, Keycloak, authenticated ledger, approved DAR versions and backed fixture pools.',
    );
  });
});
