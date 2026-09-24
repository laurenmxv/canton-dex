import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../../src/bootstrap/schema.js';
import { authenticate, profile } from '../../src/iam/accounts.js';
import type { Database } from '../../src/platform/database.js';
import { DevelopmentFixtures } from './support/fixtures.js';
import { scenario } from './support/scenario.js';

/** The 26 tables of db/schema.sql; the baseline assertion predated settlement_deferred_requests. */
const TABLES = [
  'accounts',
  'fixture_parties',
  'pools',
  'onboardings',
  'onboarding_steps',
  'venue_configuration',
  'pool_proposals',
  'pool_pair_claims',
  'pool_queues',
  'pool_request_queues',
  'swap_quotes',
  'swap_requests',
  'swap_preparations',
  'liquidity_quotes',
  'liquidity_requests',
  'liquidity_preparations',
  'settlement_batches',
  'operator_commands',
  'test_token_configuration',
  'test_token_instruments',
  'test_token_pools',
  'dev_faucet_claims',
  'token_registries',
  'token_registry_contracts',
  'token_instruments',
  'settlement_deferred_requests',
];
/** SQLSTATE class 23: an integrity constraint violation. */
async function rejects(statement: Promise<unknown>): Promise<void> {
  const failure = await statement.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure instanceof Error && 'code' in failure ? String(failure.code) : undefined).toMatch(/^23/);
}

async function single<T>(db: Kysely<Database>, query: RawBuilder<T>): Promise<T> {
  const { rows } = await query.execute(db);
  const [row] = rows;
  expect(rows).toHaveLength(1);
  if (row === undefined) throw new Error('No row');
  return row;
}

describe.runIf(scenario('schema'))('database schema', () => {
  const fixtures = new DevelopmentFixtures();
  afterAll(() => fixtures.close());

  it('creates the current schema and preserves data on repeated initialization', async () => {
    const schema = `dex_schema_test_${randomUUID().replaceAll('-', '')}`;
    await fixtures.db.connection().execute(async (db) => {
      await sql.raw(`CREATE SCHEMA ${schema}`).execute(db);
      try {
        await sql.raw(`SET search_path TO ${schema}`).execute(db);
        await initializeSchema(db);
        const tables = await sql<{ table_name: string }>`
          SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema}`.execute(db);
        expect(tables.rows.map((row) => row.table_name).sort()).toEqual([...TABLES].sort());

        const david = await authenticate(db, 'test-issuer', 'david', 'David');
        const other = await authenticate(db, 'test-issuer', 'other', 'Other');
        expect((await profile(db, david)).partyId).toBeNull();
        await rejects(sql`UPDATE accounts SET role='ADMIN' WHERE id=${david.id}`.execute(db));
        await rejects(sql`UPDATE accounts SET subject='david' WHERE id=${other.id}`.execute(db));

        const onboarding = randomUUID();
        await sql`INSERT INTO onboardings(id,account_id,application,party_mode,prepared_party_id)
          VALUES(${onboarding},${david.id},'{}','external','david-party')`.execute(db);
        await rejects(
          sql`INSERT INTO onboardings(id,account_id,application,party_mode,prepared_party_id)
            VALUES(${randomUUID()},${other.id},'{}','external','david-party')`.execute(db),
        );
        await rejects(
          sql`INSERT INTO onboardings(id,account_id,application) VALUES(${randomUUID()},${david.id},'{}')`.execute(db),
        );
        await rejects(
          sql`INSERT INTO onboardings(id,account_id,application) VALUES(${randomUUID()},${randomUUID()},'{}')`.execute(
            db,
          ),
        );

        await sql`INSERT INTO onboarding_steps(onboarding_id,step_key,command_id,status,contract_id,begin_offset,update_id,issuer)
          VALUES(${onboarding},'attestation',${randomUUID()},'CONFIRMED','attestation-cid',7,'ledger-update','operator')`.execute(
          db,
        );
        await rejects(
          sql`INSERT INTO onboarding_steps(onboarding_id,step_key,command_id,status)
            VALUES(${onboarding},'permission',${randomUUID()},'CONFIRMED')`.execute(db),
        );

        await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name)
          VALUES('pool-a','config-a','state-a','package','Shared label'),
                ('pool-b','config-b','state-b','package','Shared label')`.execute(db);
        const proposal = randomUUID();
        await sql`INSERT INTO pool_proposals(id,name,settings,factory_id,proposed_by,status,command_id,begin_offset)
          VALUES(${proposal},'Proposal','{}','factory',${david.id},'FAILED',${randomUUID()},0)`.execute(db);
        await rejects(sql`UPDATE pool_proposals SET status='INVALID' WHERE id=${proposal}`.execute(db));
        await sql`INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES('A/B','pool-a')`.execute(db);
        await rejects(sql`INSERT INTO pool_pair_claims(pair_key,pool_id) VALUES('A/B','pool-b')`.execute(db));
        await rejects(sql`INSERT INTO pool_pair_claims(pair_key) VALUES('C/D')`.execute(db));

        await sql`UPDATE onboardings SET party_status='CONFLICT' WHERE id=${onboarding}`.execute(db);
        await initializeSchema(db);
        expect(
          await single(db, sql<{ party_status: string }>`SELECT party_status FROM onboardings WHERE id=${onboarding}`),
        ).toEqual({ party_status: 'CONFLICT' });
        expect((await authenticate(db, 'test-issuer', 'david', 'David')).id).toBe(david.id);
        expect(
          await single(
            db,
            sql<{ pools: string }>`SELECT approved_pools::text AS pools FROM onboardings WHERE id=${onboarding}`,
          ),
        ).toEqual({ pools: '[]' });
        expect(
          await single(
            db,
            sql<{ contract_id: string }>`SELECT contract_id FROM onboarding_steps WHERE onboarding_id=${onboarding}`,
          ),
        ).toEqual({ contract_id: 'attestation-cid' });
        expect(
          await single(
            db,
            sql<{ count: bigint }>`SELECT count(*) AS count FROM pools
              WHERE name='Shared label' AND NOT active AND updated_at IS NOT NULL`,
          ),
        ).toEqual({ count: 2n });
        expect(
          await single(db, sql<{ status: string }>`SELECT status FROM pool_proposals WHERE id=${proposal}`),
        ).toEqual({
          status: 'FAILED',
        });
        expect(
          await single(db, sql<{ pool_id: string }>`SELECT pool_id FROM pool_pair_claims WHERE pair_key='A/B'`),
        ).toEqual({ pool_id: 'pool-a' });
      } finally {
        await sql.raw('SET search_path TO public').execute(db);
        await sql.raw(`DROP SCHEMA ${schema} CASCADE`).execute(db);
      }
    });
  });
});
