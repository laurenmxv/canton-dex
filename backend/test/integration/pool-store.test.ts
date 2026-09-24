import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolDetail, Terms } from '../../src/pools/model.js';
import { PoolStore } from '../../src/pools/store.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_SETTLEMENT_TEST_DATABASE_URL;
const TERMS: Terms = {
  dvo: 'dvo',
  baseInstrumentId: { admin: 'issuer', id: 'BTC' },
  quoteInstrumentId: { admin: 'issuer', id: 'USDC' },
  baseAccount: { owner: 'dvo', provider: 'provider', id: 'base' },
  quoteAccount: { owner: 'dvo', provider: 'provider', id: 'quote' },
  lpTokenInstrumentId: { admin: 'dvo', id: 'LP' },
  feeBps: '30',
  baseReserve: '100',
  quoteReserve: '200',
  lpTokenSupply: '100',
  initialRatio: '2',
};

describe.runIf(DATABASE_URL)('pool store', () => {
  let scratch: ScratchDatabase;

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
  });

  afterEach(() => scratch.drop());

  it('repeated schema initialization preserves a pool', async () => {
    // A current instant with microsecond digits, which the store keeps exactly.
    const now = new Date().toISOString().replace('Z', '456Z');
    await sql`INSERT INTO pools(pool_id,config_id,state_id,package_id,name,active,settings,created_at,updated_at)
      VALUES('pool','config','state','package','Test pool',true,${JSON.stringify(TERMS)}::jsonb,${now},${now})`.execute(
      scratch.db,
    );

    await scratch.initialize();
    await scratch.initialize();

    const expected: PoolDetail = {
      poolId: 'pool',
      name: 'Test pool',
      settings: TERMS,
      configId: 'config',
      stateId: 'state',
      packageId: 'package',
      createdAt: now,
      updatedAt: now,
    };
    const store = new PoolStore(scratch.db);
    expect(await store.pool('pool', 'package')).toEqual(expected);
    expect(await store.pools('package')).toEqual([expected]);
    const { rows } = await sql<{ count: bigint }>`SELECT count(*) AS count FROM pools WHERE pool_id='pool'`.execute(
      scratch.db,
    );
    expect(rows).toEqual([{ count: 1n }]);
  });
});
