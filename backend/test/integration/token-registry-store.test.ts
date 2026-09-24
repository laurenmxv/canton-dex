import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TokenRegistryStore } from '../../src/tokens/registry-store.js';
import { scenario } from './support/scenario.js';
import { scratchDatabase, type ScratchDatabase } from './support/scratch-database.js';

const DATABASE_URL = process.env.DEX_SETTLEMENT_TEST_DATABASE_URL;

describe.runIf(scenario('swaps') && DATABASE_URL)('token registry store', () => {
  let scratch: ScratchDatabase;

  beforeEach(async () => {
    scratch = await scratchDatabase(DATABASE_URL ?? '');
  });

  afterEach(() => scratch.drop());

  it('issuer configuration and overlapping instrument names survive a store restart', async () => {
    await sql`INSERT INTO token_registries(admin,allocation_factory_id,settlement_factory_id)
      VALUES('alice','alice-allocate','alice-settle'),('bob','bob-allocate','bob-settle')`.execute(scratch.db);
    await sql`INSERT INTO token_instruments(admin,instrument_id,symbol,decimals)
      VALUES('alice','USD','USD',6),('bob','USD','USD',8)`.execute(scratch.db);
    await sql`INSERT INTO token_registry_contracts(admin,contract_id,template_id,created_event_blob,synchronizer_id)
      VALUES('alice','alice-allocate','alice:Token:Allocator','BwgJ','sync-alice'),
        ('bob','bob-allocate','foreign:Token:Allocator','AQID','sync-bob'),
        ('bob','bob-settle','other:Token:Settler','BAUG','sync-bob')`.execute(scratch.db);

    const restarted = new TokenRegistryStore(scratch.reopen());
    expect(await restarted.source('alice')).toEqual({
      admin: 'alice',
      allocationFactoryId: 'alice-allocate',
      settlementFactoryId: 'alice-settle',
    });
    expect((await restarted.source('bob'))?.allocationFactoryId).toBe('bob-allocate');
    expect((await restarted.source('bob'))?.settlementFactoryId).toBe('bob-settle');
    expect(await restarted.disclosures('alice', 'bob-allocate')).toEqual([]);
    expect(await restarted.disclosures('bob', 'alice-allocate')).toEqual([]);
    expect(await restarted.disclosures('alice', 'alice-allocate')).toEqual([
      {
        templateId: 'alice:Token:Allocator',
        contractId: 'alice-allocate',
        createdEventBlob: 'BwgJ',
        synchronizerId: 'sync-alice',
      },
    ]);
    expect(await restarted.disclosures('bob', 'bob-settle')).toEqual([
      {
        templateId: 'other:Token:Settler',
        contractId: 'bob-settle',
        createdEventBlob: 'BAUG',
        synchronizerId: 'sync-bob',
      },
    ]);
    expect(await restarted.instruments()).toEqual([
      { admin: 'alice', id: 'USD', symbol: 'USD', decimals: 6 },
      { admin: 'bob', id: 'USD', symbol: 'USD', decimals: 8 },
    ]);
    expect(await restarted.source('unknown')).toBeUndefined();
  });
});
