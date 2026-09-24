import type { FixtureStore, SavedConfiguration } from '../canton/test-tokens.js';
import type { Db } from '../platform/database.js';
import type { Terms } from '../pools/model.js';

function base64(value: string): string {
  return Buffer.from(value, 'base64').toString('base64');
}

/** The test-token and fixture-pool rows; every insert keeps an existing row. */
export class SqlFixtureStore implements FixtureStore {
  constructor(private readonly db: Db) {}

  async savedConfiguration(): Promise<SavedConfiguration | undefined> {
    return this.db
      .selectFrom('test_token_configuration')
      .select([
        'issuer_party_id as issuerPartyId',
        'rules_id as rulesId',
        'package_id as packageId',
        'faucet_factory_id as faucetFactoryId',
      ])
      .where('id', '=', 1)
      .executeTakeFirst();
  }

  async saveConfiguration(
    configuration: SavedConfiguration & { rulesBlob: string; synchronizerId: string },
  ): Promise<void> {
    await this.db
      .insertInto('test_token_configuration')
      .values({
        id: 1,
        issuer_party_id: configuration.issuerPartyId,
        rules_id: configuration.rulesId,
        package_id: configuration.packageId,
        allocation_factory_id: configuration.rulesId,
        settlement_factory_id: configuration.rulesId,
        faucet_factory_id: configuration.faucetFactoryId,
        synchronizer_id: configuration.synchronizerId,
        rules_created_event_blob: base64(configuration.rulesBlob),
      })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
  }

  async saveRegistry(
    admin: string,
    rules: { contractId: string; templateId: string; createdEventBlob: string; synchronizerId: string },
  ): Promise<void> {
    await this.db
      .insertInto('token_registries')
      .values({ admin, allocation_factory_id: rules.contractId, settlement_factory_id: rules.contractId })
      .onConflict((conflict) => conflict.column('admin').doNothing())
      .execute();
    await this.db
      .insertInto('token_registry_contracts')
      .values({
        admin,
        contract_id: rules.contractId,
        template_id: rules.templateId,
        created_event_blob: base64(rules.createdEventBlob),
        synchronizer_id: rules.synchronizerId,
      })
      .onConflict((conflict) => conflict.columns(['admin', 'contract_id']).doNothing())
      .execute();
  }

  async saveInstrument(admin: string, instrumentId: string, symbol: string, decimals: number): Promise<void> {
    await this.db
      .insertInto('token_instruments')
      .values({ admin, instrument_id: instrumentId, symbol, decimals })
      .onConflict((conflict) => conflict.columns(['admin', 'instrument_id']).doNothing())
      .execute();
  }

  async saveTestInstrument(symbol: string, decimals: number, initialClaimAmount: string): Promise<void> {
    await this.db
      .insertInto('test_token_instruments')
      .values({ symbol, instrument_id: symbol, decimals, initial_claim_amount: initialClaimAmount })
      .onConflict((conflict) => conflict.column('symbol').doNothing())
      .execute();
  }

  async storePool(
    poolId: string,
    configId: string,
    stateId: string,
    packageId: string,
    name: string,
    terms: Terms,
  ): Promise<void> {
    const settings = JSON.stringify(terms);
    await this.db
      .insertInto('pools')
      .values({
        pool_id: poolId,
        config_id: configId,
        state_id: stateId,
        package_id: packageId,
        name,
        active: true,
        settings,
      })
      .onConflict((conflict) =>
        conflict.column('pool_id').doUpdateSet({ config_id: configId, state_id: stateId, active: true, settings }),
      )
      .execute();
  }

  async savePoolPair(pair: string, poolId: string): Promise<void> {
    await this.db
      .insertInto('test_token_pools')
      .values({ pair, pool_id: poolId })
      .onConflict((conflict) => conflict.column('pair').doNothing())
      .execute();
  }

  async delegationId(poolId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('test_token_pools')
      .select('delegation_id')
      .where('pool_id', '=', poolId)
      .executeTakeFirstOrThrow();
    return row.delegation_id;
  }

  async saveDelegation(poolId: string, delegationId: string): Promise<void> {
    await this.db
      .updateTable('test_token_pools')
      .set({ delegation_id: delegationId })
      .where('pool_id', '=', poolId)
      .where('delegation_id', 'is', null)
      .execute();
  }

  async savePairClaim(pairKey: string, poolId: string): Promise<void> {
    await this.db
      .insertInto('pool_pair_claims')
      .values({ pair_key: pairKey, pool_id: poolId })
      .onConflict((conflict) => conflict.column('pair_key').doNothing())
      .execute();
  }
}
